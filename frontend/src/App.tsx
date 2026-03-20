import React, { useState, useEffect } from 'react';
import { ChatScreen } from './components/ChatScreen';
import { MessageSquare, PlusCircle, Folder } from 'lucide-react';

type SessionMeta = {
  id: string;
  category: string;
  title: string;
  created_at: string;
};

function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  
  // ★ 追加: ChatScreenを強制リセットするためのキー
  const [chatKey, setChatKey] = useState<string>('new'); 

  const fetchSessions = async () => {
    try {
      // ★ 修正: ポート番号を8080（バックエンド側）に統一
      const response = await fetch('http://localhost:8080/api/sessions');
      if (response.ok) {
        const data = await response.json();
        setSessions(data);
      }
    } catch (error) {
      console.error("履歴の取得に失敗しました", error);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const handleNewChat = () => {
    setActiveSessionId(null);
    // ★ 修正: 現在時刻を使って毎回必ず違う文字列にし、ChatScreenを強制的に初期化させる
    setChatKey(`new-${Date.now()}`); 
  };

  // ★ 追加: 履歴をクリックしたときの処理を分離
  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    setChatKey(`session-${id}`);
  };

  const groupedSessions = sessions.reduce((acc, session) => {
    if (!acc[session.category]) acc[session.category] = [];
    acc[session.category].push(session);
    return acc;
  }, {} as Record<string, SessionMeta[]>);

  return (
    <div className="flex h-screen bg-gray-100 font-sans">
      <aside className="w-64 bg-gray-900 text-white flex flex-col hidden md:flex">
        <div className="p-4 border-b border-gray-700">
          <button 
            onClick={handleNewChat}
            className="w-full flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg font-bold transition"
          >
            <PlusCircle className="w-5 h-5 mr-2" /> 新規の質問
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          {Object.entries(groupedSessions).map(([category, catSessions]) => (
            <div key={category} className="mb-4">
              <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 flex items-center px-2">
                <Folder className="w-3 h-3 mr-1" /> {category}
              </h2>
              <ul className="space-y-1">
                {catSessions.map(session => (
                  <li key={session.id}>
                    <button
                      // ★ 修正: handleSelectSession を呼び出すように変更
                      onClick={() => handleSelectSession(session.id)}
                      className={`w-full text-left px-3 py-2 rounded text-sm truncate flex items-center transition ${
                        activeSessionId === session.id ? 'bg-gray-700 text-white font-bold' : 'text-gray-300 hover:bg-gray-800'
                      }`}
                      title={session.title}
                    >
                      <MessageSquare className="w-4 h-4 mr-2 flex-shrink-0" />
                      {session.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside>

      <main className="flex-1 relative">
        <ChatScreen 
          // ★ 修正: activeSessionId ではなく chatKey を使うことで確実に再マウントされる
          key={chatKey} 
          initialSessionId={activeSessionId} 
          onSessionUpdate={fetchSessions} 
        />
      </main>
    </div>
  );
}

export default App;