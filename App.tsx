
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Chat, GenerateContentResponse } from '@google/genai';
import { AppState, WebsiteData, TranscriptionEntry, InteractionMode } from './types';
import { SYSTEM_INSTRUCTION_BASE, PRESET_SITES } from './constants';
import { VoiceSessionManager } from './services/geminiService';
import { Visualizer } from './components/Visualizer';

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(AppState.IDLE);
  const [mode, setMode] = useState<InteractionMode>(InteractionMode.VOICE);
  const [url, setUrl] = useState('');
  const [websiteData, setWebsiteData] = useState<WebsiteData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [showIntegration, setShowIntegration] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');

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
  };

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setState(AppState.PREPARING);
    setError(null);
    setTranscriptions([]);
    setShowIntegration(false);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const prompt = `CRITICAL: EXECUTE DEEP BUSINESS INTELLIGENCE MAPPING FOR: ${url}.
      
      TASK: You are a Senior Business Analyst. Map the entire brand DNA of this website.
      
      REQUIRED DATA POINTS:
      1. Brand Core: What is the primary business value?
      2. Market Position: What are the key products and how do they stand out in the market?
      3. Strategic Facts: What are the top features, prices, or policies mentioned?
      4. Persuasive Voice: Describe the brand's professional tone.
      
      INSTRUCTIONS:
      - Use live search grounding to access the actual content.
      - Focus on converting visitors into customers.
      
      RETURN JSON ONLY:
      {
        "businessName": "Official Brand Identity",
        "description": "Sophisticated executive summary of the business and its purpose",
        "tone": "Brand voice descriptor (e.g. Luxury, High-Tech, Trusted Expert)",
        "keyFacts": ["7 detailed strategic selling points and key offerings found on site"]
      }`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: { 
          responseMimeType: 'application/json',
          tools: [{ googleSearch: {} }] 
        }
      });

      const data = JSON.parse(response.text || '{}');
      
      if (!data.businessName || data.businessName.toLowerCase().includes("not found")) {
        throw new Error("Could not map business DNA from this URL.");
      }

      setWebsiteData({
        url,
        name: data.businessName,
        description: data.description,
        tone: data.tone,
        keyFacts: data.keyFacts
      });
      setState(AppState.READY);
    } catch (err) {
      console.error(err);
      setError("Strategic mapping failed. Please ensure the business URL is public and accessible.");
      setState(AppState.IDLE);
    }
  };

  const getSystemInstruction = () => {
    if (!websiteData) return '';
    return SYSTEM_INSTRUCTION_BASE
      .replace(/{url}/g, websiteData.url)
      .replace(/{name}/g, websiteData.name)
      .replace(/{description}/g, websiteData.description)
      .replace(/{tone}/g, websiteData.tone)
      .replace(/{keyFacts}/g, websiteData.keyFacts.join(', '));
  };

  const startVoice = async () => {
    if (!websiteData) return;
    setMode(InteractionMode.VOICE);
    setState(AppState.CONNECTING);
    setTranscriptions([]);

    try {
      sessionManager.current = new VoiceSessionManager(
        process.env.API_KEY || '',
        (message) => {
          if (message.serverContent?.modelTurn) {
            setIsModelSpeaking(true);
            setIsUserSpeaking(false);
          }
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
          setError("Strategic session interrupted.");
          setState(AppState.READY);
        }
      );
      await sessionManager.current.connect(getSystemInstruction());
      setState(AppState.CONVERSING);
    } catch (err) {
      setError("Microphone required for the executive voice consultant.");
      setState(AppState.IDLE);
    }
  };

  const startChat = () => {
    if (!websiteData) return;
    setMode(InteractionMode.CHAT);
    setState(AppState.CONVERSING);
    setTranscriptions([]);

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
    chatSession.current = ai.chats.create({
      model: 'gemini-3-flash-preview',
      config: { systemInstruction: getSystemInstruction() },
    });

    setTranscriptions([{
      type: 'model',
      text: `Greetings! I am the Senior Executive Consultant for ${websiteData.name}. I've thoroughly mapped our business database and I'm ready to provide you with expert guidance. How can I assist you with our services today?`
    }]);
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
    } catch (err) {
      setError("Consultation failed.");
    } finally {
      setIsChatLoading(false);
    }
  };

  const stopConversation = () => {
    sessionManager.current?.disconnect();
    chatSession.current = null;
    setState(AppState.READY);
    setIsModelSpeaking(false);
    setIsUserSpeaking(false);
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  const IntegrationDashboard = () => {
    const scriptTag = `<script src="https://sitevoice.io/v1/representative.js" data-site-id="${btoa(websiteData?.url || '').slice(0, 10)}" data-mode="executive" async></script>`;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/98 backdrop-blur-xl animate-in fade-in duration-300">
        <div className="bg-[#0a0a0a] border border-neutral-800 w-full max-w-4xl rounded-[3rem] shadow-2xl overflow-hidden flex flex-col max-h-[95vh]">
          <div className="p-8 border-b border-neutral-800 flex justify-between items-center bg-neutral-900/30">
            <div>
              <h3 className="text-2xl font-bold">Deploy Executive Agent</h3>
              <p className="text-gray-400 text-sm">Professional sales representation for your digital presence.</p>
            </div>
            <button onClick={() => setShowIntegration(false)} className="p-4 hover:bg-neutral-800 rounded-full transition-all">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          
          <div className="flex-grow overflow-y-auto p-10 space-y-16">
            <section className="space-y-6">
              <div className="flex items-center gap-6">
                <div className="w-14 h-14 bg-blue-600 rounded-3xl flex items-center justify-center font-bold text-2xl shadow-xl shadow-blue-600/30">1</div>
                <div>
                  <h4 className="text-xl font-bold">Copy Activation Tag</h4>
                  <p className="text-gray-500 text-sm">Embed the professional consultant into your website UI.</p>
                </div>
              </div>
              <div className="ml-20 relative group">
                <div className="bg-neutral-900 rounded-3xl p-8 font-mono text-sm text-blue-400 border border-neutral-800 group-hover:border-blue-500/30 transition-all leading-relaxed break-all">
                  {scriptTag}
                </div>
                <button 
                  onClick={() => copyToClipboard(scriptTag)}
                  className={`absolute right-6 top-6 px-6 py-2 rounded-xl text-xs font-bold text-white shadow-lg active:scale-95 transition-all ${copyStatus === 'copied' ? 'bg-emerald-600' : 'bg-blue-600 hover:bg-blue-500'}`}
                >
                  {copyStatus === 'copied' ? 'Copied!' : 'Copy Tag'}
                </button>
              </div>
            </section>

            <section className="space-y-6 pb-10">
              <div className="flex items-center gap-6">
                <div className="w-14 h-14 bg-emerald-600 rounded-3xl flex items-center justify-center font-bold text-2xl shadow-xl shadow-emerald-600/30">2</div>
                <h4 className="text-xl font-bold">Live Integration Instructions</h4>
              </div>
              <div className="ml-20 space-y-4">
                <p className="text-gray-400 leading-relaxed">
                  Paste the activation tag into the <code>&lt;head&gt;</code> section or just before the closing <code>&lt;/body&gt;</code> tag of your website. This will instantly activate the Senior Executive Consultant for all your visitors.
                </p>
                <button onClick={() => setShowIntegration(false)} className="bg-white text-black px-12 py-5 rounded-2xl font-bold text-lg hover:bg-neutral-200 transition-all shadow-2xl active:scale-95">
                  Finish Integration
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-4 md:p-8">
      {showIntegration && <IntegrationDashboard />}
      
      <header className="w-full max-w-5xl flex justify-between items-center mb-12">
        <div className="flex items-center gap-3 cursor-pointer" onClick={resetToHome}>
          <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-2xl shadow-blue-900/20">
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <h1 className="text-3xl font-black tracking-tighter">SiteVoice</h1>
        </div>
        <div className="flex items-center gap-4">
           {error && <span className="text-red-400 text-xs font-bold bg-red-900/20 px-4 py-2 rounded-xl border border-red-900/50">{error}</span>}
           <div className="flex items-center gap-2 px-4 py-2 bg-neutral-900 border border-neutral-800 rounded-2xl">
             <span className="w-2.5 h-2.5 bg-blue-500 rounded-full animate-pulse shadow-[0_0_10px_#3b82f6]"></span>
             <span className="text-[10px] text-gray-300 uppercase tracking-widest font-black">Executive Mode</span>
           </div>
        </div>
      </header>

      <main className="w-full max-w-2xl flex flex-col gap-8 flex-grow">
        {state === AppState.IDLE && (
          <div className="space-y-16 animate-in fade-in slide-in-from-bottom-8 duration-1000">
            <div className="text-center space-y-6">
              <h2 className="text-6xl md:text-7xl font-black tracking-tighter leading-[0.9]">
                Expert Consultation.<br/><span className="gradient-text">Absolute Authority.</span>
              </h2>
              <p className="text-xl text-gray-500 max-w-lg mx-auto leading-relaxed font-light">
                SiteVoice maps your business DNA to provide high-level professional representation that converts visitors into loyal customers.
              </p>
            </div>

            <form onSubmit={handleUrlSubmit} className="space-y-6">
              <div className="relative group">
                <input
                  type="url"
                  placeholder="Analyze Business URL (e.g. apple.com/mac)"
                  required
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-[2rem] px-10 py-8 text-2xl focus:ring-8 focus:ring-blue-500/5 focus:border-blue-500 outline-none transition-all placeholder:text-neutral-800 shadow-2xl"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <button type="submit" className="absolute right-4 top-4 bottom-4 bg-blue-600 hover:bg-blue-500 text-white px-10 rounded-[1.5rem] font-black text-lg shadow-xl active:scale-95 transition-all">Map Brand</button>
              </div>
              <div className="flex flex-wrap gap-3 justify-center">
                {PRESET_SITES.map(site => (
                  <button 
                    key={site.url} 
                    type="button" 
                    onClick={() => { setUrl(site.url); }}
                    className="text-xs font-black uppercase tracking-widest bg-neutral-900 hover:bg-neutral-800 text-gray-400 hover:text-white px-5 py-3 rounded-xl border border-neutral-800 transition-all active:scale-95"
                  >
                    {site.name}
                  </button>
                ))}
              </div>
            </form>
          </div>
        )}

        {state === AppState.PREPARING && (
          <div className="flex flex-col items-center justify-center py-32 gap-10">
            <div className="relative">
              <div className="w-32 h-32 border-8 border-blue-500/5 border-t-blue-500 rounded-full animate-spin"></div>
              <div className="absolute inset-0 flex items-center justify-center text-blue-400">
                <svg className="w-12 h-12 animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
              </div>
            </div>
            <div className="text-center space-y-3">
              <h3 className="text-3xl font-black">Strategic Brand Analysis...</h3>
              <p className="text-gray-500 font-medium">Extracting business intelligence, competitive edges, and professional tone.</p>
            </div>
          </div>
        )}

        {state === AppState.READY && websiteData && (
          <div className="bg-neutral-900/40 border border-neutral-800 p-12 rounded-[3.5rem] space-y-12 animate-in zoom-in-95 duration-500 shadow-2xl">
            <div className="flex items-center gap-8">
              <div className="w-24 h-24 bg-gradient-to-br from-blue-600 to-blue-800 rounded-[2.5rem] flex items-center justify-center text-5xl font-black shadow-2xl shadow-blue-900/40">
                {websiteData.name.charAt(0)}
              </div>
              <div>
                <h3 className="text-4xl font-black tracking-tight">{websiteData.name}</h3>
                <p className="text-blue-500 font-bold opacity-60 truncate max-w-xs">{websiteData.url}</p>
              </div>
            </div>

            <div className="space-y-8">
              <div className="space-y-3">
                <p className="text-[11px] text-gray-600 uppercase font-black tracking-[0.3em]">Brand DNA Overview</p>
                <p className="text-xl text-gray-200 leading-relaxed font-light italic">"{websiteData.description}"</p>
              </div>
              <div className="grid grid-cols-2 gap-10">
                <div className="space-y-2">
                  <p className="text-[11px] text-gray-600 uppercase font-black tracking-[0.3em]">Representative Role</p>
                  <p className="text-blue-400 font-bold text-lg">Senior {websiteData.tone} Representative</p>
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] text-gray-600 uppercase font-black tracking-[0.3em]">Intelligence Status</p>
                  <p className="text-emerald-500 font-bold text-lg">Fully Optimized</p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-6 pt-6">
              <div className="grid grid-cols-2 gap-6">
                <button onClick={startVoice} className="bg-white text-black py-6 rounded-[2rem] font-black text-xl hover:bg-neutral-100 transition-all active:scale-95 shadow-xl">Voice Consultant</button>
                <button onClick={startChat} className="bg-neutral-800 text-white py-6 rounded-[2rem] font-black text-xl hover:bg-neutral-700 transition-all border border-neutral-700 active:scale-95">Executive Chat</button>
              </div>
              
              <button onClick={() => setShowIntegration(true)} className="w-full bg-blue-600 hover:bg-blue-500 text-white py-8 rounded-[2rem] font-black text-2xl flex items-center justify-center gap-4 transition-all shadow-2xl shadow-blue-600/20 active:scale-95">
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                Deploy Professional Agent
              </button>

              <button onClick={resetToHome} className="w-full bg-neutral-900 border border-neutral-800 text-gray-400 py-4 rounded-[1.5rem] font-bold text-sm hover:text-white transition-all active:scale-95">
                Map New Business
              </button>
            </div>
          </div>
        )}

        {(state === AppState.CONNECTING || state === AppState.CONVERSING) && (
          <div className="flex flex-col flex-grow bg-neutral-900/20 border border-neutral-800 rounded-[3.5rem] overflow-hidden animate-in fade-in zoom-in-95 shadow-2xl">
            <div className="p-8 bg-neutral-900/60 border-b border-neutral-800 flex justify-between items-center backdrop-blur-3xl">
              <div className="flex items-center gap-5">
                <div className="w-14 h-14 bg-neutral-800 rounded-3xl flex items-center justify-center font-black text-2xl text-blue-500 shadow-xl">
                  {websiteData?.name.charAt(0)}
                </div>
                <div>
                  <h4 className="font-black text-lg">{websiteData?.name} Senior Consultant</h4>
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span className="text-[10px] text-gray-500 uppercase font-black tracking-widest">Master Strategy Active</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={resetToHome} title="New Analysis" className="w-12 h-12 flex items-center justify-center hover:bg-neutral-800 text-gray-400 rounded-2xl transition-all">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
                </button>
                <button onClick={stopConversation} className="w-12 h-12 flex items-center justify-center hover:bg-red-500/20 text-red-500 rounded-2xl transition-all">
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>

            <div className="flex-grow flex flex-col p-10 overflow-hidden relative">
              {mode === InteractionMode.VOICE ? (
                <div className="flex-grow flex flex-col items-center justify-center gap-16">
                  <div className="relative">
                    <div className={`absolute -inset-24 bg-blue-600/10 rounded-full blur-[100px] transition-opacity duration-1000 ${isModelSpeaking ? 'opacity-100' : 'opacity-0'}`}></div>
                    <div className={`absolute -inset-24 bg-purple-600/10 rounded-full blur-[100px] transition-opacity duration-1000 ${isUserSpeaking ? 'opacity-100' : 'opacity-0'}`}></div>
                    <div className={`relative w-72 h-72 rounded-[4rem] bg-neutral-900/60 border-[8px] border-neutral-800 flex items-center justify-center transition-all duration-700 ${isModelSpeaking ? 'scale-110 border-blue-600 rotate-3 shadow-blue-600/20 shadow-2xl' : isUserSpeaking ? 'scale-105 border-purple-600 -rotate-3 shadow-purple-600/20 shadow-2xl' : 'scale-100'}`}>
                      <Visualizer isSpeaking={isModelSpeaking} isListening={isUserSpeaking} />
                    </div>
                  </div>
                  <div className="text-center space-y-3">
                    <p className="text-2xl font-black text-white">{isModelSpeaking ? 'Consulting Expert...' : isUserSpeaking ? 'Listening to Inquiry...' : 'Expert Online'}</p>
                    <p className="text-xs text-gray-600 uppercase tracking-[0.3em] font-black">Strategic Consultant Protocol</p>
                  </div>
                </div>
              ) : (
                <div ref={scrollRef} className="flex-grow overflow-y-auto space-y-8 pb-8 pr-4 custom-scrollbar">
                  {transcriptions.map((t, i) => (
                    <div key={i} className={`flex ${t.type === 'user' ? 'justify-end' : 'justify-start'} animate-in slide-in-from-bottom-4`}>
                      <div className={`max-w-[90%] px-8 py-6 rounded-[2.5rem] text-lg leading-relaxed shadow-2xl ${t.type === 'user' ? 'bg-blue-600 text-white rounded-tr-none' : 'bg-neutral-800 text-gray-100 rounded-tl-none border border-neutral-700/50'}`}>
                        {t.text}
                      </div>
                    </div>
                  ))}
                  {isChatLoading && <div className="flex justify-start"><div className="bg-neutral-800/40 px-10 py-6 rounded-full animate-pulse font-black text-blue-500">CONSULTING DATABASE...</div></div>}
                </div>
              )}

              <div className="mt-auto pt-8 border-t border-neutral-800/50">
                {mode === InteractionMode.CHAT && (
                  <form onSubmit={handleSendMessage} className="relative">
                    <input
                      type="text" placeholder="Speak with the expert consultant..."
                      className="w-full bg-neutral-800/50 border border-neutral-700 rounded-[2rem] px-8 py-6 text-xl focus:ring-8 focus:ring-blue-600/5 outline-none pr-20"
                      value={chatInput} onChange={(e) => setChatInput(e.target.value)} disabled={isChatLoading}
                    />
                    <button type="submit" disabled={!chatInput.trim() || isChatLoading} className="absolute right-4 top-4 bottom-4 bg-blue-600 hover:bg-blue-500 text-white px-6 rounded-2xl transition-all active:scale-95 shadow-lg">
                      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                    </button>
                  </form>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
      
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1a1a1a; border-radius: 20px; }
        .gradient-text { background: linear-gradient(to right, #3b82f6, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      `}</style>
    </div>
  );
};

export default App;
