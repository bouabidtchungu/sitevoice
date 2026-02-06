import React, { useState, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';
import { AppState, WebsiteData, TranscriptionEntry, InteractionMode } from './types';
import { SYSTEM_INSTRUCTION_BASE } from './constants';

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(AppState.IDLE);
  const [url, setUrl] = useState('');
  const [websiteData, setWebsiteData] = useState<WebsiteData | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const chatSession = useRef<any>(null);

  // دالة بناء التعليمات البرمجية (البرومبت الاحترافي)
  const getFullSystemInstruction = (data: WebsiteData) => {
    return SYSTEM_INSTRUCTION_BASE
      .replace(/{url}/g, data.url)
      .replace(/{name}/g, data.name)
      .replace(/{description}/g, data.description)
      .replace(/{tone}/g, data.tone)
      .replace(/{keyFacts}/g, data.keyFacts.join(', '));
  };

  // دالة التحليل (المسؤولة عن تفعيل الزر)
  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    setState(AppState.PREPARING);
    
    try {
      // ملاحظة: تأكد من تسمية المفتاح GEMINI_API_KEY في Vercel
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY || ''; 
      const genAI = new GoogleGenAI(apiKey);
      const model = genAI.getGenerativeModel({ 
        model: 'gemini-1.5-flash',
        generationConfig: { responseMimeType: 'application/json' }
      });

      const prompt = `Analyze this URL: ${url}. Return JSON: { "url": "${url}", "name": "Brand Name", "description": "Expert Description", "tone": "Professional", "keyFacts": ["Fact 1", "Fact 2"] }`;
      
      const result = await model.generateContent(prompt);
      const data = JSON.parse(result.response.text()) as WebsiteData;
      
      setWebsiteData(data);
      
      // بدء الجلسة فوراً بعد التحليل بنجاح
      const chatModel = genAI.getGenerativeModel({ 
        model: 'gemini-1.5-flash',
        systemInstruction: getFullSystemInstruction(data)
      });

      chatSession.current = chatModel.startChat({
        generationConfig: { temperature: 0.2 }
      });

      setTranscriptions([{ type: 'model', text: `تم تحليل الموقع بنجاح! أنا المستشار الخاص بـ ${data.name}. كيف يمكنني مساعدتك؟` }]);
      setState(AppState.CONVERSING);

    } catch (err) {
      console.error(err);
      alert("حدث خطأ أثناء التحليل. تأكد من إعداد مفتاح API في Vercel.");
      setState(AppState.IDLE);
    }
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
      console.error(err);
    } finally {
      setIsChatLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white p-6 flex flex-col items-center">
      <h1 className="text-4xl font-black mb-8 gradient-text">SiteVoice Expert</h1>

      {state === AppState.IDLE || state === AppState.PREPARING ? (
        <form onSubmit={handleUrlSubmit} className="w-full max-w-2xl">
          <div className="relative">
            <input
              type="url"
              placeholder="ضع رابط الموقع هنا..."
              className="w-full bg-neutral-900 border border-neutral-800 rounded-2xl px-6 py-4 text-xl outline-none focus:border-blue-500"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <button 
              type="submit" 
              disabled={state === AppState.PREPARING}
              className="absolute right-2 top-2 bottom-2 bg-blue-600 px-6 rounded-xl font-bold hover:bg-blue-500 disabled:bg-neutral-700"
            >
              {state === AppState.PREPARING ? 'جاري التحليل...' : 'تحليل'}
            </button>
          </div>
        </form>
      ) : (
        <div className="w-full max-w-4xl flex-1 flex flex-col bg-neutral-950 border border-neutral-900 rounded-3xl overflow-hidden shadow-2xl">
          <header className="p-4 border-b border-neutral-900 bg-black/50 flex justify-between items-center">
            <h2 className="font-bold text-blue-400">{websiteData?.name}</h2>
            <button onClick={() => setState(AppState.IDLE)} className="text-xs text-neutral-500 underline">تغيير الموقع</button>
          </header>

          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {transcriptions.map((t, i) => (
              <div key={i} className={`flex ${t.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] p-4 rounded-2xl ${t.type === 'user' ? 'bg-blue-600' : 'bg-neutral-900 border border-neutral-800'}`}>
                  {t.text}
                </div>
              </div>
            ))}
            {isChatLoading && <div className="text-blue-500 animate-pulse">الخبير يحلل ويجيب...</div>}
          </div>

          <form onSubmit={handleSendMessage} className="p-4 bg-black border-t border-neutral-900 flex gap-2">
            <input
              type="text"
              className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 outline-none focus:border-blue-500"
              placeholder="اسأل الخبير..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
            />
            <button type="submit" className="bg-blue-600 px-6 rounded-xl font-bold">إرسال</button>
          </form>
        </div>
      )}
    </div>
  );
};

export default App;