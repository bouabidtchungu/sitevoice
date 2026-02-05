
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
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

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
      
      TASK: You are a Senior Business Analyst. Map the entire brand DNA of this website to empower a high-level human-like representative.
      
      REQUIRED STRATEGIC DATA:
      1. Brand Core: What is the primary business value and mission?
      2. Market Advantage: Why should a customer choose this specific brand over competitors?
      3. Strategic Facts: What are the specific products, services, or prices mentioned?
      4. Executive Tone: How should a senior representative of this brand speak (e.g. Expert, Luxury, Friendly)?
      
      RETURN JSON ONLY:
      {
        "businessName": "Official Brand Name",
        "description": "Sophisticated executive summary of the business identity",
        "tone": "Brand voice descriptor",
        "keyFacts": ["7 detailed strategic selling points and offerings found on the site"]
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
      setError("Strategic mapping failed. Ensure the URL is public and valid.");
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
          setError("Connection reset.");
          setState(AppState.READY);
        }
      );
      await sessionManager.current.connect(getSystemInstruction());
      setState(AppState.CONVERSING);
    } catch (err) {
      setError("Microphone access required.");
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
      text: `Greetings! I am the Senior Executive Consultant for ${websiteData.name}. I've thoroughly mapped our brand's strategic DNA and I'm ready to assist you. How can I help you today?`
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
      setError("Strategic consultation interrupted.");
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
      // Primary method: Modern Clipboard API
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        setCopyStatus('copied');
      } else {
        // Fallback method: ExecCommand
        if (textAreaRef.current) {
          textAreaRef.current.value = text;
          textAreaRef.current.select();
          document.execCommand('copy');
          setCopyStatus('copied');
        }
      }
      setTimeout(() => setCopyStatus('idle'), 2000);
    } catch (err) {
      console.error('Copy failed:', err);
      // Last resort visual cue
      alert("Please copy the text manually from the screen.");
    }
  };

  const IntegrationDashboard = () => {
    const siteId = btoa(websiteData?.url || '').slice(0, 12);
    const scriptTag = `<script src="https://sitevoice.io/v1/agent.js" data-site-id="${siteId}" data-mode="executive" async></script>`;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/98 backdrop-blur-xl animate-in fade-in duration-300">
        <textarea ref={textAreaRef} className="absolute opacity-0 pointer-events-none" readOnly />
        <div className="bg-[#0a0a0a] border border-neutral-800 w-full max-w-4xl rounded-[3rem] shadow-2xl overflow-hidden flex flex-col max-h-[95vh]">
          <div className="p-8 border-b border-neutral-800 flex justify-between items-center bg-neutral-900/30">
            <div>
              <h3 className="text-2xl font-bold">Strategic Deployment</h3>
              <p className="text-gray-400 text-sm">Deploying your Senior Executive Representative to any website.</p>
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
                  <h4 className="text-xl font-bold">Copy Your Global Tag</h4>
                  <p className="text-gray-500 text-sm">Paste this into any website to activate the specialist.</p>
                </div>
              </div>
              <div className="ml-20 relative group">
                <div className="bg-neutral-900 rounded-3xl p-8 font-mono text-sm text-blue-400 border border-neutral-800 group-hover:border-blue-500/30 transition-all leading-relaxed break-all">
                  {scriptTag}
                </div>
                <button 
                  onClick={() => copyToClipboard(scriptTag)}
                  className={`absolute right-6 top-6 px-8 py-3 rounded-2xl text-xs font-black uppercase tracking-widest text-white shadow-xl active:scale-95 transition-all ${copyStatus === 'copied' ? 'bg-emerald-600' : 'bg-blue-600 hover:bg-blue-500'}`}
                >
                  {copyStatus === 'copied' ? 'Success!' : 'Copy Tag'}
                </button>
              </div>
            </section>

            <section className="space-y-8 pb-10">
              <div className="flex items-center gap-6">
                <div className="w-14 h-14 bg-emerald-600 rounded-3xl flex items-center justify-center font-bold text-2xl shadow-xl shadow-emerald-600/30">2</div>
                <div>
                  <h4 className="text-xl font-bold">Link Any Industry</h4>
                  <p className="text-gray-500 text-sm">One engine, infinite specialized industries.</p>
                </div>
              </div>
              <div className="ml-20 grid grid-cols-2 gap-6">
                <div className="p-6 bg-neutral-900/50 border border-neutral-800 rounded-3xl space-y-3">
                  <div className="w-10 h-10 bg-orange-600/20 rounded-xl flex items-center justify-center text-orange-500">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                  </div>
                  <h5 className="font-bold">E-Commerce</h5>
                  <p className="text-xs text-gray-500">Handles complex product queries and checkout assistance.</p>
                </div>
                <div className="p-6 bg-neutral-900/50 border border-neutral-800 rounded-3xl space-y-3">
                  <div className="w-10 h-10 bg-purple-600/20 rounded-xl flex items-center justify-center text-purple-500">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                  </div>
                  <h5 className="font-bold">Education</h5>
                  <p className="text-xs text-gray-500">Provides tutoring and answers math/science inquiries fluently.</p>
                </div>
              </div>
              <div className="ml-20 flex justify-center pt-8">
                <button onClick={() => setShowIntegration(false)} className="bg-white text-black px-16 py-6 rounded-[2rem] font-black text-xl hover:bg-neutral-200 transition-all shadow-2xl active:scale-95">
                  Confirm Multi-Site Deployment
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
             <span className="text-[10px] text-gray-300 uppercase tracking-widest font-black">Strategic Core Active</span>
           </div>
        </div>
      </header>

      <main className="w-full max-w-2xl flex flex-col gap-8 flex-grow">
        {state === AppState.IDLE && (
          <div className="space-y-16 animate-in fade-in slide-in-from-bottom-8 duration-1000">
            <div className="text-center space-y-6">
              <h2 className="text-6xl md:text-7xl font-black tracking-tighter leading-[0.9]">
                Expert Voices.<br/><span className="gradient-text">Unified Intelligence.</span>
              </h2>
              <p className="text-xl text-gray-500 max-w-lg mx-auto leading-relaxed font-light">
                Map any website's business DNA. Link car mechanics, math teachers, or global stores to one expert engine.
              </p>
            </div>

            <form onSubmit={handleUrlSubmit} className="space-y-6">
              <div className="relative group">
                <input
                  type="url"
                  placeholder="Link Business URL (e.g. apple.com/mac)"
                  required
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-[2rem] px-10 py-8 text-2xl focus:ring-8 focus:ring-blue-500/5 focus:border-blue-500 outline-none transition-all placeholder:text-neutral-800 shadow-2xl"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <button type="submit" className="absolute right-4 top-4 bottom-4 bg-blue-600 hover:bg-blue-500 text-white px-10 rounded-[1.5rem] font-black text-lg shadow-xl active:scale-95 transition-all">Map DNA</button>
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
              <h3 className="text-3xl font-black">Strategic DNA Mapping...</h3>
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
                <p className="text-[11px] text-gray-600 uppercase font-black tracking-[0.3em]">Business Intelligence</p>
                <p className="text-xl text-gray-200 leading-relaxed font-light italic">"{websiteData.description}"</p>
              </div>
              <div className="grid grid-cols-2 gap-10">
                <div className="space-y-2">
                  <p className="text-[11px] text-gray-600 uppercase font-black tracking-[0.3em]">Representative Persona</p>
                  <p className="text-blue-400 font-bold text-lg">Senior {websiteData.tone} Consultant</p>
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] text-gray-600 uppercase font-black tracking-[0.3em]">Mapping Status</p>
                  <p className="text-emerald-500 font-bold text-lg">Optimized & Linked</p>
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
                Analyze New Business
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
