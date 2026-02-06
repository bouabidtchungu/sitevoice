
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
  const [groundingLinks, setGroundingLinks] = useState<{title: string, uri: string}[]>([]);

  const sessionManager = useRef<VoiceSessionManager | null>(null);
  const chatSession = useRef<Chat | null>(null);
  const transcriptionBuffer = useRef<{ user: string; model: string }>({ user: '', model: '' });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcriptions, isModelSpeaking, isUserSpeaking, chatInput]);

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
    if (!apiKey || apiKey === '' || apiKey === 'undefined') {
      setError({ 
        message: "API Key Missing", 
        technical: "Please add your API Key to the project environment variables." 
      });
      setState(AppState.IDLE);
      return;
    }

    const ai = new GoogleGenAI({ apiKey });
    const prompt = `Map the business DNA for: ${url}. 
    Return a JSON profile:
    {
      "businessName": "Official Name",
      "description": "Executive summary.",
      "tone": "One word defining professional voice.",
      "keyFacts": ["Fact 1", "Fact 2", "Fact 3", "Fact 4"]
    }`;

    try {
      // ATTEMPT 1: With Google Search (Best Quality)
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
        // ATTEMPT 2: Fallback without search tools if quota (429) is hit
        if (innerErr.message?.includes("429") || innerErr.message?.includes("RESOURCE_EXHAUSTED")) {
          console.warn("Quota hit on Search tool. Falling back to internal knowledge.");
          response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: `The Search tool is restricted. Use your internal knowledge to map this business: ${url}. Return JSON only.`,
            config: { responseMimeType: 'application/json' }
          });
        } else {
          throw innerErr;
        }
      }

      const responseText = response.text?.trim() || '';
      if (!responseText) throw new Error("Empty response from Strategic Core.");

      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const links = chunks.filter(c => c.web).map(c => ({ title: c.web.title, uri: c.web.uri }));
      setGroundingLinks(links);

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseErr) {
        const match = responseText.match(/\{[\s\S]*\}/);
        if (match) data = JSON.parse(match[0]);
        else throw new Error("Malformed data structure.");
      }
      
      setWebsiteData({
        url,
        name: data.businessName || "Unknown Brand",
        description: data.description || "Website mapped via internal database.",
        tone: data.tone || "Professional",
        keyFacts: data.keyFacts || ["Online Presence"]
      });
      setState(AppState.READY);
    } catch (err: any) {
      console.error("Mapping Error:", err);
      setError({
        message: err.message.includes("429") ? "API Quota Exceeded" : "Mapping Failure",
        technical: err.message,
        isQuota: err.message.includes("429") || err.message.includes("RESOURCE_EXHAUSTED")
      });
      setState(AppState.IDLE);
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
          setError({ message: "Connection Error", technical: err.message });
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
    setTranscriptions([{ type: 'model', text: `Greetings! I am the consultant for ${websiteData.name}. How can I help?` }]);
  };

  const stopConversation = () => {
    sessionManager.current?.disconnect();
    chatSession.current = null;
    setState(AppState.READY);
    setIsModelSpeaking(false);
    setIsUserSpeaking(false);
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-4 md:p-8">
      <header className="w-full max-w-5xl flex justify-between items-center mb-12">
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
        <div className="w-full max-w-2xl mb-8 animate-in slide-in-from-top-4">
          <div className="bg-red-900/10 border border-red-500/30 p-6 rounded-[2rem] shadow-2xl">
            <div className="flex gap-4 items-start">
              <div className="w-10 h-10 bg-red-500 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold">!</div>
              <div className="flex-grow">
                <p className="font-black text-red-500 text-lg uppercase tracking-tight">{error.message}</p>
                <div className="mt-2 text-xs font-mono text-red-300/60 bg-black/20 p-3 rounded-xl">
                  {error.technical}
                </div>
              </div>
              <button onClick={() => setError(null)} className="text-red-500 p-2">✕</button>
            </div>
            {error.isQuota && (
              <div className="mt-4 p-4 bg-red-500/10 rounded-xl text-sm text-red-200">
                <strong>Solution:</strong> Your API key has hit its daily or minute limit. Please wait a few minutes or enable billing in <a href="https://ai.google.dev/" target="_blank" className="underline font-bold">Google AI Studio</a>.
              </div>
            )}
          </div>
        </div>
      )}

      <main className="w-full max-w-2xl flex flex-col gap-8 flex-grow">
        {state === AppState.IDLE && (
          <div className="space-y-16 animate-in fade-in slide-in-from-bottom-8">
            <div className="text-center space-y-6">
              <h2 className="text-6xl md:text-7xl font-black tracking-tighter leading-[0.9]">
                Expert Voices.<br/><span className="gradient-text">Unified Intelligence.</span>
              </h2>
              <p className="text-xl text-gray-500 max-w-lg mx-auto font-light">
                Map any website's business DNA. Link specialists to one expert engine.
              </p>
            </div>

            <form onSubmit={handleUrlSubmit} className="space-y-6">
              <div className="relative group">
                <input
                  type="url" placeholder="Link Business URL" required
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-[2rem] px-10 py-8 text-2xl focus:ring-8 focus:ring-blue-500/5 focus:border-blue-500 outline-none transition-all placeholder:text-neutral-800 shadow-2xl"
                  value={url} onChange={(e) => setUrl(e.target.value)}
                />
                <button type="submit" className="absolute right-4 top-4 bottom-4 bg-blue-600 hover:bg-blue-500 text-white px-10 rounded-[1.5rem] font-black text-lg shadow-xl active:scale-95 transition-all">Map DNA</button>
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
            <div className="w-32 h-32 border-8 border-blue-500/5 border-t-blue-500 rounded-full animate-spin"></div>
            <h3 className="text-3xl font-black">Strategic DNA Mapping...</h3>
          </div>
        )}

        {state === AppState.READY && websiteData && (
          <div className="bg-neutral-900/40 border border-neutral-800 p-12 rounded-[3.5rem] space-y-12 animate-in zoom-in-95 shadow-2xl">
            <div className="flex items-center gap-8">
              <div className="w-24 h-24 bg-blue-600 rounded-[2.5rem] flex items-center justify-center text-5xl font-black shadow-2xl">
                {websiteData.name.charAt(0)}
              </div>
              <div>
                <h3 className="text-4xl font-black tracking-tight">{websiteData.name}</h3>
                <p className="text-blue-500 font-bold opacity-60 truncate max-w-xs">{websiteData.url}</p>
              </div>
            </div>
            <div className="space-y-3">
              <p className="text-[11px] text-gray-600 uppercase font-black tracking-[0.3em]">Intelligence Brief</p>
              <p className="text-xl text-gray-200 leading-relaxed font-light italic">"{websiteData.description}"</p>
            </div>
            <div className="flex flex-col gap-6 pt-6">
              <div className="grid grid-cols-2 gap-6">
                <button onClick={startVoice} className="bg-white text-black py-6 rounded-[2rem] font-black text-xl hover:bg-neutral-100 transition-all active:scale-95 shadow-xl">Voice Link</button>
                <button onClick={startChat} className="bg-neutral-800 text-white py-6 rounded-[2rem] font-black text-xl hover:bg-neutral-700 transition-all border border-neutral-700 active:scale-95">Executive Chat</button>
              </div>
              <button onClick={resetToHome} className="w-full bg-neutral-900 border border-neutral-800 text-gray-400 py-4 rounded-[1.5rem] font-bold text-sm hover:text-white active:scale-95">Analyze New Business</button>
            </div>
          </div>
        )}

        {(state === AppState.CONNECTING || state === AppState.CONVERSING) && (
          <div className="flex flex-col flex-grow bg-neutral-900/20 border border-neutral-800 rounded-[3.5rem] overflow-hidden shadow-2xl min-h-[500px]">
            <div className="p-8 bg-neutral-900/60 border-b border-neutral-800 flex justify-between items-center">
              <div className="flex items-center gap-5">
                <div className="w-14 h-14 bg-neutral-800 rounded-3xl flex items-center justify-center font-black text-2xl text-blue-500">
                  {websiteData?.name.charAt(0)}
                </div>
                <div>
                  <h4 className="font-black text-lg">{websiteData?.name} Consultant</h4>
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span className="text-[10px] text-gray-500 uppercase font-black tracking-widest">Master Strategy Active</span>
                  </div>
                </div>
              </div>
              <button onClick={stopConversation} className="w-12 h-12 flex items-center justify-center hover:bg-red-500/20 text-red-500 rounded-2xl transition-all">
                ✕
              </button>
            </div>

            <div className="flex-grow flex flex-col p-10 overflow-hidden relative">
              {mode === InteractionMode.VOICE ? (
                <div className="flex-grow flex flex-col items-center justify-center gap-16">
                  <div className={`relative w-72 h-72 rounded-[4rem] bg-neutral-900/60 border-[8px] border-neutral-800 flex items-center justify-center transition-all duration-700 ${isModelSpeaking ? 'scale-110 border-blue-600 rotate-3 shadow-blue-600/20' : isUserSpeaking ? 'scale-105 border-purple-600 -rotate-3 shadow-purple-600/20' : 'scale-100'}`}>
                    <Visualizer isSpeaking={isModelSpeaking} isListening={isUserSpeaking} />
                  </div>
                  <p className="text-2xl font-black text-white">{isModelSpeaking ? 'Consulting Expert...' : isUserSpeaking ? 'Listening...' : 'Expert Online'}</p>
                </div>
              ) : (
                <div ref={scrollRef} className="flex-grow overflow-y-auto space-y-8 pb-8 pr-4 custom-scrollbar">
                  {transcriptions.map((t, i) => (
                    <div key={i} className={`flex ${t.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[90%] px-8 py-6 rounded-[2.5rem] text-lg ${t.type === 'user' ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-gray-100'}`}>
                        {t.text}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1a1a1a; border-radius: 20px; }
      `}</style>
    </div>
  );
};

export default App;
