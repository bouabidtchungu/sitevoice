import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Chat } from '@google/genai';
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

  const sessionManager = useRef<VoiceSessionManager | null>(null);
  const chatSession = useRef<Chat | null>(null);

  const getFullSystemInstruction = () => {
    if (!websiteData) return '';
    return SYSTEM_INSTRUCTION_BASE
      .replace(/{url}/g, websiteData.url)
      .replace(/{name}/g, websiteData.name)
      .replace(/{description}/g, websiteData.description)
      .replace(/{tone}/g, websiteData.tone)
      .replace(/{keyFacts}/g, websiteData.keyFacts.join(', '));
  };

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    setError(null);
    setState(AppState.PREPARING);

    try {
      const apiKey = process.env.API_KEY || '';
      const genAI = new GoogleGenAI({ apiKey });
      const model = genAI.getGenerativeModel({ 
        model: 'gemini-1.5-flash',
        generationConfig: { responseMimeType: 'application/json' }
      });

      const prompt = `Analyze this URL: ${url}. Return JSON: { "url": "${url}", "name": "Brand Name", "description": "Brief description", "tone": "Tone", "keyFacts": ["Fact 1", "Fact 2"] }`;
      const result = await model.generateContent(prompt);
      const data = JSON.parse(result.response.text()) as WebsiteData;
      setWebsiteData(data);
      setState(AppState.READY);
    } catch (err: any) {
      setError({ message: 'Failed to analyze website', technical: err.message });
      setState(AppState.IDLE);
    }
  };

  const startChat = () => {
    if (!websiteData) return;
    setMode(InteractionMode.CHAT);
    setState(AppState.CONVERSING);

    const apiKey = process.env.API_KEY || '';
    const genAI = new GoogleGenAI({ apiKey });
    
    chatSession.current = genAI.getGenerativeModel({ 
      model: 'gemini-1.5-flash',
      systemInstruction: getFullSystemInstruction()
    }).startChat({
      history: [],
      generationConfig: {
        temperature: 0.2, // القيمة السحرية لمنع الهلوسة
        maxOutputTokens: 1000,
      }
    });

    setTranscriptions([{ type: 'model', text: `Greetings! I am the expert consultant for ${websiteData.name}. How can I assist you today?` }]);
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !chatSession.current) return;

    const userText = chatInput;
    setChatInput('');
    setTranscriptions(prev => [...prev, { type: 'user', text: userText }]);
    setIsChatLoading(true);

    try {
      const result = await chatSession.current.sendMessage(userText);
      setTranscriptions(prev => [...prev, { type: 'model', text: result.response.text() }]);
    } catch (err) {
      setError({ message: 'Message failed to send' });
    } finally {
      setIsChatLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white font-sans flex flex-col">
      {state === AppState.IDLE || state === AppState.PREPARING ? (
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <h1 className="text-5xl font-black mb-4 gradient-text">SiteVoice Expert</h1>
          <p className="text-neutral-400 text-xl mb-12 max-w-lg">Transform any URL into a professional sales consultant.</p>
          <form onSubmit={handleUrlSubmit} className="w-full max-w-2xl relative">
            <input
              type="url" placeholder="Enter website URL (e.g., https://imac.ma)"
              className="w-full bg-neutral-900 border-2 border-neutral-800 rounded-3xl px-8 py-6 text-xl outline-none focus:border-blue-500 transition-all shadow-2xl"
              value={url} onChange={(e) => setUrl(e.target.value)}
            />
            <button type="submit" disabled={state === AppState.PREPARING} className="absolute right-3 top-3 bottom-3 bg-blue-600 px-8 rounded-2xl font-bold hover:bg-blue-500 transition-all">
              {state === AppState.PREPARING ? 'Analyzing...' : 'Analyze'}
            </button>
          </form>
        </div>
      ) : (
        <div className="flex-1 flex flex-col">
          <header className="p-6 border-b border-neutral-800 flex justify-between items-center bg-black/50 backdrop-blur-md">
            <div>
              <h2 className="text-2xl font-black">{websiteData?.name}</h2>
              <p className="text-blue-500 font-medium">{websiteData?.url}</p>
            </div>
            <button onClick={() => setState(AppState.IDLE)} className="text-neutral-500 hover:text-white transition-colors">Change Site</button>
          </header>

          <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
            {transcriptions.map((t, i) => (
              <div key={i} className={`flex ${t.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] p-4 rounded-2xl ${t.type === 'user' ? 'bg-blue-600' : 'bg-neutral-900 border border-neutral-800'}`}>
                  {t.text}
                </div>
              </div>
            ))}
            {isChatLoading && <div className="text-neutral-500 animate-pulse">Expert is thinking...</div>}
          </div>

          <footer className="p-6 border-t border-neutral-800">
            <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto flex gap-4">
              <input
                type="text" placeholder="Ask our expert consultant..."
                className="flex-1 bg-neutral-900 border border-neutral-800 rounded-2xl px-6 py-4 outline-none focus:border-blue-500"
                value={chatInput} onChange={(e) => setChatInput(e.target.value)}
              />
              <button type="submit" className="bg-blue-600 px-8 rounded-2xl font-bold">Send</button>
            </form>
          </footer>
        </div>
      )}
    </div>
  );
};

export default App;