
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Chat, GenerateContentResponse, Type } from '@google/genai';
import { AppState, WebsiteData, TranscriptionEntry, InteractionMode } from './types';
import { SYSTEM_INSTRUCTION_BASE, PRESET_SITES } from './constants';
import { VoiceSessionManager } from './services/geminiService';
import { Visualizer } from './components/Visualizer';

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(AppState.IDLE);
  const [mode, setMode] = useState<InteractionMode>(InteractionMode.VOICE);
  const [url, setUrl] = useState('');
  const [websiteData, setWebsiteData] = useState<WebsiteData | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<{message: string, technical?: string, isQuota?: boolean} | null>(null);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [groundingLinks, setGroundingLinks] = useState<{title: string, uri: string}[]>([]);

  const sessionManager = useRef<VoiceSessionManager | null>(null);
  const chatSession = useRef<Chat | null>(null);
  const transcriptionBuffer = useRef<{ user: string; model: string }>({ user: '', model: '' });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcriptions, isChatLoading, chatInput]);

  const resetToHome = () => {
    sessionManager.current?.disconnect();
    chatSession.current = null;
    setWebsiteData(null);
    setUrl('');
    setTranscriptions([]);
    setState(AppState.IDLE);
    setError(null);
    setGroundingLinks([]);
  };

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setState(AppState.PREPARING);
    setError(null);
    setTranscriptions([]);
    setGroundingLinks([]);

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      setError({ message: "API Key Missing", technical: "Ensure API_KEY is set in environment variables." });
      setState(AppState.IDLE);
      return;
    }

    const ai = new GoogleGenAI({ apiKey });
    
    // Detailed Grounding Prompt
    const prompt = `Perform a DEEP STRATEGIC AUDIT of the business at: ${url}.
    
    CRITICAL INSTRUCTIONS:
    1. Use Google Search to find the ACTUAL business name, their primary products/services, and location.
    2. If the URL contains "imac.ma", verify if it is the "IMAC" Apple Reseller or the "IMAC" Aviation School. Look for product lists like "iPhone", "MacBook", "iPad".
    3. Provide a high-precision executive summary.
    
    JSON SCHEMA:
    {
      "businessName": "Exact official name",
      "description": "Comprehensive summary (2-3 sentences) detailing specific products/services.",
      "tone": "One word defining brand persona.",
      "keyFacts": ["Fact 1", "Fact 2", "Fact 3", "Fact 4"]
    }`;

    try {
      let response;
      try {
        response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: prompt,
          config: { 
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                businessName: { type: Type.STRING },
                description: { type: Type.STRING },
                tone: { type: Type.STRING },
                keyFacts: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ["businessName", "description", "tone", "keyFacts"]
            },
            tools: [{ googleSearch: {} }] 
          }
        });
      } catch (innerErr: any) {
        console.warn("Search tool quota hit or failed. Falling back to logical inference.");
        response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `Analyze the URL keywords for ${url} (e.g., .ma = Morocco, imac = likely Apple products). Predict the business profile and return ONLY JSON.`,
          config: { responseMimeType: 'application/json' }
        });
      }

      const responseText = response.text?.trim() || '';
      const data = JSON.parse(responseText.match(/\{[\s\S]*\}/)?.[0] || responseText);
      
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const links = chunks.filter(c => c.web).map(c => ({ title: c.web.title, uri: c.web.uri }));
      setGroundingLinks(links);

      setWebsiteData({
        url,
        name: data.businessName || "Unknown Brand",
        description: data.description || "Identified via domain keyword analysis.",
        tone: data.tone || "Professional",
        keyFacts: data.keyFacts || ["Online Presence"]
      });
      setState(AppState.READY);
    } catch (err: any) {
      setError({ message: "Mapping Failure", technical: err.message, isQuota: err.message.includes("429") });
      setState(AppState.IDLE);
    }
  };

  const getFullSystemInstruction = () => {
    if (!websiteData) return '';
    return SYSTEM_INSTRUCTION_BASE
      .replace(/{url}/g, websiteData.url)
      .replace(/{name}/g, websiteData.name)
      .replace(/{description}/g, websiteData.description)
      .replace(/{tone}/g, websiteData.tone)
      .replace(/{keyFacts}/g, websiteData.keyFacts.join(', '));
  };

  const startChat = () => {
    if (!websiteData) return;
    setMode(InteractionMode.CHAT);
    setState(AppState.CONVERSING);
    
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
    chatSession.current = ai.chats.create({
      model: 'gemini-3-flash-preview',
      config: { systemInstruction: getFullSystemInstruction() },
    });
    setTranscriptions([{ type: 'model', text: `Greetings! I am the consultant for ${websiteData.name}. How can I assist you today?` }]);
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!chatInput.trim() || !chatSession.current || isChatLoading) return;

    const userMsg = chatInput;
    setChatInput('');
    setTranscriptions(prev => [...prev, { type: 'user', text: userMsg }]);
    setIsChatLoading(true);

    try {
      const result = await chatSession.current.sendMessageStream({ message: userMsg });
      let fullModelResponse = '';
      setTranscriptions(prev => [...prev, { type: 'model', text: '' }]);
      
      for await (const chunk of result) {
        const chunkText = (chunk as GenerateContentResponse).text || '';
        fullModelResponse += chunkText;
        setTranscriptions(prev => {
          const newTrans = [...prev];
          newTrans[newTrans.length - 1] = { type: 'model', text: fullModelResponse };
          return newTrans;
        });
      }
    } catch (err: any) {
      setError({ message: "Message Interrupted", technical: err.message });
    } finally {
      setIsChatLoading(false);
    }
  };

  const startVoice = async () => {
    if (!websiteData) return;
    setMode(InteractionMode.VOICE);
    setState(AppState.CONNECTING);
    try {
      sessionManager.current = new VoiceSessionManager(
        process.env.API_KEY || '',
        (message) => {
          if (message.serverContent?.modelTurn) setIsModelSpeaking(true);
          if (message.serverContent?.outputTranscription) {
            transcriptionBuffer.current.model += message.serverContent.outputTranscription.text;
          }
          if (message.serverContent?.inputTranscription) {
            transcriptionBuffer.current.user += message.serverContent.inputTranscription.text;
            setIsUserSpeaking(true);
            setIsModelSpeaking(false);
          }
          if (message.serverContent?.turnComplete) {
            const user = transcriptionBuffer.current.user;
            const model = transcriptionBuffer.current.model;
            if (user || model) {
              setTranscriptions(prev => [
                ...prev,
                ...(user ? [{ text: user, type: 'user' as const }] : []),
                ...(model ? [{ text: model, type: 'model' as const }] : [])
              ]);
            }
            transcriptionBuffer.current = { user: '', model: '' };
            setIsModelSpeaking(false);
            setIsUserSpeaking(false);
          }
        },
        (err) => {
          setError({ message: "Voice Error", technical: err.message });
          setState(AppState.READY);
        }
      );
      await sessionManager.current.connect(getFullSystemInstruction());
      setState(AppState.CONVERSING);
    } catch (err: any) {
      setError({ message: "Microphone Error", technical: err.message });
      setState(AppState.READY);
    }
  };

  const updateWebsiteData = (e: React.FormEvent) => {
    e.preventDefault();
    setIsEditing(false);
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-4 md:p-8">
      <header className="w-full max-w-5xl flex justify-between items-center mb-12 flex-shrink-0">
        <div className="flex items-center gap-3 cursor-pointer" onClick={resetToHome}>
          <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-xl">
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <h1 className="text-3xl font-black tracking-tighter">SiteVoice</h1>
        </div>
        {state === AppState.READY && (
           <button onClick={() => setIsEditing(!isEditing)} className="text-xs font-black uppercase tracking-widest text-blue-500 hover:text-blue-400">
             {isEditing ? 'Close Editor' : 'Edit DNA Brief'}
           </button>
        )}
      </header>

      {error && (
        <div className="w-full max-w-2xl mb-8 flex-shrink-0">
          <div className="bg-red-900/10 border border-red-500/30 p-6 rounded-[2rem] shadow-2xl animate-in slide-in-from-top-4">
            <div className="flex gap-4">
              <div className="w-10 h-10 bg-red-500 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold">!</div>
              <div className="flex-grow overflow-hidden">
                <p className="font-black text-red-500">{error.message}</p>
                <p className="text-xs font-mono text-red-300/60 mt-1 truncate">{error.technical}</p>
              </div>
              <button onClick={() => setError(null)} className="text-red-500">✕</button>
            </div>
          </div>
        </div>
      )}

      <main className="w-full max-w-2xl flex flex-col flex-grow overflow-hidden">
        {state === AppState.IDLE && (
          <div className="space-y-16 py-12 animate-in fade-in slide-in-from-bottom-8">
            <div className="text-center space-y-6">
              <h2 className="text-6xl md:text-7xl font-black tracking-tighter leading-[0.9]">
                Expert Voices.<br/><span className="gradient-text">Unified Intelligence.</span>
              </h2>
              <p className="text-xl text-gray-500 max-w-lg mx-auto font-light">Map any business. Grant it a voice.</p>
            </div>
            <form onSubmit={handleUrlSubmit} className="space-y-6">
              <div className="relative group">
                <input
                  type="url" placeholder="Paste Business URL (e.g. imac.ma)" required
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-[2rem] px-10 py-8 text-2xl focus:border-blue-500 outline-none transition-all shadow-2xl"
                  value={url} onChange={(e) => setUrl(e.target.value)}
                />
                <button type="submit" className="absolute right-4 top-4 bottom-4 bg-blue-600 hover:bg-blue-500 text-white px-10 rounded-[1.5rem] font-black transition-all">Map</button>
              </div>
              <div className="flex flex-wrap gap-3 justify-center">
                {PRESET_SITES.map(site => (
                  <button key={site.url} type="button" onClick={() => setUrl(site.url)} className="text-xs font-black uppercase tracking-widest bg-neutral-900 hover:bg-neutral-800 text-gray-400 px-5 py-3 rounded-xl border border-neutral-800 transition-all active:scale-95">
                    {site.name}
                  </button>
                ))}
              </div>
            </form>
          </div>
        )}

        {state === AppState.PREPARING && (
          <div className="flex flex-col items-center justify-center py-32 gap-10">
            <div className="w-24 h-24 border-8 border-blue-600/10 border-t-blue-600 rounded-full animate-spin"></div>
            <h3 className="text-3xl font-black animate-pulse">Consulting Strategic Repositories...</h3>
          </div>
        )}

        {state === AppState.READY && websiteData && (
          <div className="space-y-8 animate-in zoom-in-95">
            {isEditing ? (
              <form onSubmit={updateWebsiteData} className="bg-neutral-900 border border-blue-500/30 p-10 rounded-[3rem] space-y-6 shadow-2xl">
                <h3 className="text-xl font-black uppercase tracking-widest text-blue-500">Correct AI Hallucination</h3>
                <div className="space-y-4">
                  <label className="block text-xs font-bold text-gray-500 uppercase">Business Name</label>
                  <input className="w-full bg-neutral-800 border border-neutral-700 p-4 rounded-xl outline-none focus:border-blue-500" value={websiteData.name} onChange={e => setWebsiteData({...websiteData, name: e.target.value})} />
                  
                  <label className="block text-xs font-bold text-gray-500 uppercase">Executive Description</label>
                  <textarea rows={4} className="w-full bg-neutral-800 border border-neutral-700 p-4 rounded-xl outline-none focus:border-blue-500" value={websiteData.description} onChange={e => setWebsiteData({...websiteData, description: e.target.value})} />
                </div>
                <button type="submit" className="w-full bg-blue-600 py-4 rounded-2xl font-black uppercase tracking-widest">Update Intelligence Profile</button>
              </form>
            ) : (
              <div className="bg-neutral-900/40 border border-neutral-800 p-12 rounded-[3.5rem] space-y-12 shadow-2xl">
                <div className="flex items-center gap-8">
                  <div className="w-24 h-24 bg-blue-600 rounded-[2.5rem] flex items-center justify-center text-5xl font-black shadow-2xl">
                    {websiteData.name.charAt(0)}
                  </div>
                  <div className="overflow-hidden">
                    <h3 className="text-4xl font-black tracking-tight truncate">{websiteData.name}</h3>
                    <p className="text-blue-500 font-bold opacity-60 truncate">{websiteData.url}</p>
                  </div>
                </div>
                <div className="space-y-2">
                   <p className="text-xs font-black text-gray-600 uppercase tracking-widest">DNA Mapping Result</p>
                   <p className="text-xl text-gray-200 leading-relaxed font-light italic">"{websiteData.description}"</p>
                </div>
                
                {groundingLinks.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-black text-gray-600 uppercase tracking-widest">Source Grounding</p>
                    <div className="flex flex-wrap gap-2">
                      {groundingLinks.map((link, idx) => (
                        <a key={idx} href={link.uri} target="_blank" className="text-[10px] bg-neutral-800 border border-neutral-700 px-3 py-1 rounded-full text-blue-400 hover:text-blue-300 transition-colors">
                          {link.title || 'Source'} ↗
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <button onClick={startVoice} className="bg-white text-black py-6 rounded-[2rem] font-black text-xl hover:bg-neutral-100 active:scale-95 shadow-xl transition-all">Voice Link</button>
                  <button onClick={startChat} className="bg-neutral-800 text-white py-6 rounded-[2rem] font-black text-xl hover:bg-neutral-700 active:scale-95 transition-all">Executive Chat</button>
                </div>
                <button onClick={resetToHome} className="w-full text-gray-600 text-[10px] font-black uppercase tracking-[0.3em] hover:text-white transition-all">Reset & New Analysis</button>
              </div>
            )}
          </div>
        )}

        {(state === AppState.CONNECTING || state === AppState.CONVERSING) && (
          <div className="flex flex-col flex-grow bg-neutral-900/40 border border-neutral-800 rounded-[3.5rem] overflow-hidden shadow-2xl relative min-h-0">
            {/* Header */}
            <div className="p-8 bg-neutral-900/60 border-b border-neutral-800 flex justify-between items-center flex-shrink-0">
              <div className="flex items-center gap-5">
                <div className="w-12 h-12 bg-neutral-800 rounded-2xl flex items-center justify-center font-black text-blue-500 shadow-lg">
                  {websiteData?.name.charAt(0)}
                </div>
                <div>
                  <h4 className="font-black truncate max-w-[150px]">{websiteData?.name} Expert</h4>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span className="text-[10px] text-gray-500 uppercase font-black">Strategic Connection Active</span>
                  </div>
                </div>
              </div>
              <button onClick={() => setState(AppState.READY)} className="w-10 h-10 flex items-center justify-center rounded-xl hover:bg-red-500/10 text-red-500 transition-all font-bold">✕</button>
            </div>

            {/* Conversation Flow */}
            <div className="flex-grow overflow-hidden flex flex-col p-8 min-h-0">
              {mode === InteractionMode.VOICE ? (
                <div className="flex-grow flex flex-col items-center justify-center gap-12">
                  <div className={`w-64 h-64 rounded-[4rem] bg-neutral-900/60 border-4 border-neutral-800 flex items-center justify-center transition-all duration-500 ${isModelSpeaking ? 'scale-110 border-blue-500 shadow-[0_0_60px_rgba(59,130,246,0.15)] rotate-3' : isUserSpeaking ? 'scale-105 border-purple-500 shadow-[0_0_60px_rgba(168,85,247,0.15)] -rotate-3' : 'scale-100 opacity-60'}`}>
                    <Visualizer isSpeaking={isModelSpeaking} isListening={isUserSpeaking} />
                  </div>
                  <p className="text-xl font-black uppercase tracking-[0.2em] text-gray-400">
                    {isModelSpeaking ? <span className="text-blue-500">Expert Speaking</span> : isUserSpeaking ? <span className="text-purple-500">Listening to You</span> : 'Connection Idle'}
                  </p>
                </div>
              ) : (
                <div ref={scrollRef} className="flex-grow overflow-y-auto space-y-6 pr-4 custom-scrollbar scroll-smooth">
                  {transcriptions.map((t, i) => (
                    <div key={i} className={`flex ${t.type === 'user' ? 'justify-end' : 'justify-start'} animate-in slide-in-from-bottom-2`}>
                      <div className={`max-w-[85%] px-7 py-5 rounded-[2rem] text-lg leading-relaxed ${t.type === 'user' ? 'bg-blue-600 text-white rounded-br-none shadow-xl shadow-blue-900/20' : 'bg-neutral-800 text-gray-100 rounded-bl-none border border-neutral-700 shadow-xl'}`}>
                        {t.text || <span className="opacity-40 animate-pulse tracking-widest font-black">...</span>}
                      </div>
                    </div>
                  ))}
                  {isChatLoading && (
                    <div className="flex justify-start">
                      <div className="bg-neutral-800/50 px-6 py-4 rounded-[1.5rem] rounded-bl-none border border-neutral-700/50">
                        <div className="flex gap-1">
                          <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></span>
                          <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce delay-100"></span>
                          <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce delay-200"></span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Input Overlay */}
            {mode === InteractionMode.CHAT && (
              <div className="p-6 bg-neutral-900/80 border-t border-neutral-800 flex-shrink-0 backdrop-blur-md">
                <form onSubmit={handleSendMessage} className="relative max-w-xl mx-auto">
                  <input
                    type="text" placeholder="Consult the brand expert..."
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-[1.8rem] px-8 py-5 text-lg outline-none pr-24 focus:border-blue-500 transition-all shadow-inner"
                    value={chatInput} onChange={(e) => setChatInput(e.target.value)} disabled={isChatLoading}
                  />
                  <button type="submit" disabled={!chatInput.trim() || isChatLoading} className="absolute right-3 top-3 bottom-3 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 text-white px-6 rounded-2xl font-black transition-all active:scale-95 shadow-lg">
                    Send
                  </button>
                </form>
              </div>
            )}
          </div>
        )}
      </main>
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e1e1e; border-radius: 20px; }
        .delay-100 { animation-delay: 100ms; }
        .delay-200 { animation-delay: 200ms; }
      `}</style>
    </div>
  );
};

export default App;
