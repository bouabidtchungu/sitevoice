
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
  const [error, setError] = useState<{message: string, technical?: string, isQuota?: boolean} | null>(null);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);

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
  };

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setState(AppState.PREPARING);
    setError(null);
    setTranscriptions([]);

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      setError({ message: "API Key Missing", technical: "Check environment variables." });
      setState(AppState.IDLE);
      return;
    }

    const ai = new GoogleGenAI({ apiKey });
    
    // Improved Prompt for Accuracy
    const prompt = `Act as an expert Business DNA Mapper. 
    URL: ${url}
    
    TASK: Identify the EXACT business. 
    IF SEARCH FAILS: Analyze the URL string carefully. (e.g., "imac.ma" is almost certainly a retail store for Apple products in Morocco). Do NOT hallucinate a school or institution unless verified.
    
    OUTPUT JSON:
    {
      "businessName": "Official Store Name",
      "description": "Accurate summary of what they sell or do.",
      "tone": "One word defining voice.",
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
        // Silent Fallback for Free Tier Quota
        console.warn("Quota limit hit. Using predictive mapping logic.");
        response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `The search tool is unavailable. Predict the business for ${url} based on the domain name keywords. Return JSON only.`,
          config: { responseMimeType: 'application/json' }
        });
      }

      const responseText = response.text?.trim() || '';
      const data = JSON.parse(responseText.match(/\{[\s\S]*\}/)?.[0] || responseText);
      
      setWebsiteData({
        url,
        name: data.businessName || "Unknown Brand",
        description: data.description || "Website identified via internal mapping.",
        tone: data.tone || "Professional",
        keyFacts: data.keyFacts || ["Online Retailer"]
      });
      setState(AppState.READY);
    } catch (err: any) {
      setError({ message: "Mapping Failure", technical: err.message, isQuota: err.message.includes("429") });
      setState(AppState.IDLE);
    }
  };

  const startChat = () => {
    if (!websiteData) return;
    setMode(InteractionMode.CHAT);
    setState(AppState.CONVERSING);
    
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
    chatSession.current = ai.chats.create({
      model: 'gemini-3-flash-preview',
      config: { 
        systemInstruction: SYSTEM_INSTRUCTION_BASE
          .replace(/{url}/g, websiteData.url)
          .replace(/{name}/g, websiteData.name)
          .replace(/{description}/g, websiteData.description)
          .replace(/{tone}/g, websiteData.tone)
          .replace(/{keyFacts}/g, websiteData.keyFacts.join(', '))
      },
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
      
      // Add empty model message to start streaming into
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
      setError({ message: "Message Failed", technical: err.message });
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
      await sessionManager.current.connect(SYSTEM_INSTRUCTION_BASE
        .replace(/{url}/g, websiteData.url)
        .replace(/{name}/g, websiteData.name)
        .replace(/{description}/g, websiteData.description)
        .replace(/{tone}/g, websiteData.tone)
        .replace(/{keyFacts}/g, websiteData.keyFacts.join(', ')));
      setState(AppState.CONVERSING);
    } catch (err: any) {
      setError({ message: "Microphone Access", technical: err.message });
      setState(AppState.READY);
    }
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
      </header>

      {error && (
        <div className="w-full max-w-2xl mb-8 flex-shrink-0">
          <div className="bg-red-900/10 border border-red-500/30 p-6 rounded-[2rem] shadow-2xl">
            <div className="flex gap-4">
              <div className="w-10 h-10 bg-red-500 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold">!</div>
              <div className="flex-grow">
                <p className="font-black text-red-500">{error.message}</p>
                <p className="text-xs font-mono text-red-300/60 mt-1">{error.technical}</p>
              </div>
              <button onClick={() => setError(null)} className="text-red-500">✕</button>
            </div>
          </div>
        </div>
      )}

      <main className="w-full max-w-2xl flex flex-col flex-grow overflow-hidden">
        {state === AppState.IDLE && (
          <div className="space-y-16 py-12">
            <div className="text-center space-y-6">
              <h2 className="text-6xl md:text-7xl font-black tracking-tighter leading-[0.9]">
                Expert Voices.<br/><span className="gradient-text">Unified Intelligence.</span>
              </h2>
              <p className="text-xl text-gray-500 max-w-lg mx-auto font-light">Map any website's DNA. Let it speak.</p>
            </div>
            <form onSubmit={handleUrlSubmit} className="space-y-6">
              <div className="relative group">
                <input
                  type="url" placeholder="Paste URL (e.g. imac.ma)" required
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-[2rem] px-10 py-8 text-2xl focus:border-blue-500 outline-none transition-all shadow-2xl"
                  value={url} onChange={(e) => setUrl(e.target.value)}
                />
                <button type="submit" className="absolute right-4 top-4 bottom-4 bg-blue-600 hover:bg-blue-500 text-white px-10 rounded-[1.5rem] font-black">Map</button>
              </div>
              <div className="flex flex-wrap gap-3 justify-center">
                {PRESET_SITES.map(site => (
                  <button key={site.url} type="button" onClick={() => setUrl(site.url)} className="text-xs font-black uppercase tracking-widest bg-neutral-900 hover:bg-neutral-800 text-gray-400 px-5 py-3 rounded-xl border border-neutral-800">
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
            <h3 className="text-3xl font-black">Analyzing DNA...</h3>
          </div>
        )}

        {state === AppState.READY && websiteData && (
          <div className="bg-neutral-900/40 border border-neutral-800 p-12 rounded-[3.5rem] space-y-12 shadow-2xl">
            <div className="flex items-center gap-8">
              <div className="w-24 h-24 bg-blue-600 rounded-[2.5rem] flex items-center justify-center text-5xl font-black">
                {websiteData.name.charAt(0)}
              </div>
              <div>
                <h3 className="text-4xl font-black tracking-tight">{websiteData.name}</h3>
                <p className="text-blue-500 font-bold opacity-60">{websiteData.url}</p>
              </div>
            </div>
            <p className="text-xl text-gray-200 leading-relaxed font-light italic">"{websiteData.description}"</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <button onClick={startVoice} className="bg-white text-black py-6 rounded-[2rem] font-black text-xl hover:bg-neutral-100 active:scale-95 shadow-xl">Voice Link</button>
              <button onClick={startChat} className="bg-neutral-800 text-white py-6 rounded-[2rem] font-black text-xl hover:bg-neutral-700 active:scale-95">Executive Chat</button>
            </div>
            <button onClick={resetToHome} className="w-full text-gray-500 text-sm font-bold uppercase tracking-widest">New Mapping</button>
          </div>
        )}

        {(state === AppState.CONNECTING || state === AppState.CONVERSING) && (
          <div className="flex flex-col flex-grow bg-neutral-900/40 border border-neutral-800 rounded-[3.5rem] overflow-hidden shadow-2xl relative min-h-0">
            {/* Conversation Header */}
            <div className="p-8 bg-neutral-900/60 border-b border-neutral-800 flex justify-between items-center flex-shrink-0">
              <div className="flex items-center gap-5">
                <div className="w-12 h-12 bg-neutral-800 rounded-2xl flex items-center justify-center font-black text-blue-500">
                  {websiteData?.name.charAt(0)}
                </div>
                <div>
                  <h4 className="font-black">{websiteData?.name} Expert</h4>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span className="text-[10px] text-gray-500 uppercase font-black">Live</span>
                  </div>
                </div>
              </div>
              <button onClick={() => setState(AppState.READY)} className="p-3 text-red-500 font-bold">✕</button>
            </div>

            {/* Content Area */}
            <div className="flex-grow overflow-hidden flex flex-col p-8 min-h-0">
              {mode === InteractionMode.VOICE ? (
                <div className="flex-grow flex flex-col items-center justify-center gap-10">
                  <div className={`w-64 h-64 rounded-full bg-neutral-900/60 border-4 border-neutral-800 flex items-center justify-center transition-all ${isModelSpeaking ? 'scale-110 border-blue-500 shadow-[0_0_50px_rgba(59,130,246,0.2)]' : isUserSpeaking ? 'scale-105 border-purple-500 shadow-[0_0_50px_rgba(168,85,247,0.2)]' : 'scale-100'}`}>
                    <Visualizer isSpeaking={isModelSpeaking} isListening={isUserSpeaking} />
                  </div>
                  <p className="text-xl font-bold">{isModelSpeaking ? 'Expert is Speaking...' : isUserSpeaking ? 'I am Listening...' : 'Expert Ready'}</p>
                </div>
              ) : (
                <div ref={scrollRef} className="flex-grow overflow-y-auto space-y-6 pr-4 custom-scrollbar">
                  {transcriptions.map((t, i) => (
                    <div key={i} className={`flex ${t.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] px-6 py-4 rounded-[1.8rem] text-lg ${t.type === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 'bg-neutral-800 text-gray-100 rounded-bl-none border border-neutral-700'}`}>
                        {t.text || <span className="opacity-50 animate-pulse">...</span>}
                      </div>
                    </div>
                  ))}
                  {isChatLoading && <div className="text-blue-500 text-xs font-black animate-pulse uppercase tracking-widest">Consulting Intelligence...</div>}
                </div>
              )}
            </div>

            {/* Message Input Container */}
            {mode === InteractionMode.CHAT && (
              <div className="p-6 bg-neutral-900/60 border-t border-neutral-800 flex-shrink-0">
                <form onSubmit={handleSendMessage} className="relative">
                  <input
                    type="text" placeholder="Speak with the brand expert..."
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-[1.5rem] px-6 py-5 text-lg outline-none pr-20 focus:border-blue-500"
                    value={chatInput} onChange={(e) => setChatInput(e.target.value)} disabled={isChatLoading}
                  />
                  <button type="submit" disabled={!chatInput.trim() || isChatLoading} className="absolute right-3 top-3 bottom-3 bg-blue-600 text-white px-5 rounded-xl font-bold disabled:opacity-50">
                    Send
                  </button>
                </form>
              </div>
            )}
          </div>
        )}
      </main>
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1a1a1a; border-radius: 20px; }
      `}</style>
    </div>
  );
};

export default App;
