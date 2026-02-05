
import React from 'react';

interface VisualizerProps {
  isSpeaking: boolean;
  isListening: boolean;
}

export const Visualizer: React.FC<VisualizerProps> = ({ isSpeaking, isListening }) => {
  return (
    <div className="flex items-center justify-center gap-1 h-32 w-full">
      {[...Array(20)].map((_, i) => (
        <div
          key={i}
          className={`w-1.5 rounded-full transition-all duration-150 ${
            isSpeaking 
              ? 'bg-blue-400' 
              : isListening 
                ? 'bg-purple-400' 
                : 'bg-gray-700'
          }`}
          style={{
            height: isSpeaking || isListening 
              ? `${Math.random() * (isSpeaking ? 100 : 60) + 10}%` 
              : '8px',
            animation: isSpeaking || isListening 
              ? `pulse ${0.5 + Math.random()}s infinite ease-in-out` 
              : 'none',
            animationDelay: `${i * 0.05}s`
          }}
        />
      ))}
    </div>
  );
};
