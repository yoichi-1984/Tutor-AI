import { useState, useEffect } from 'react';
import { ChatScreen } from './components/ChatScreen';
import { MessageSquare, PlusCircle, Folder, FlipHorizontal } from 'lucide-react';

type SessionMeta = {
  id: string;
  category: string;
  title: string;
  exam_type?: string;
  grade?: string;
  created_at: string;
};

function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [examType, setExamType] = useState<'junior-high' | 'high-school'>('junior-high');
  const [grade, setGrade] = useState<string>('小6');
  const [isMirrored, setIsMirrored] = useState<boolean>(() => {
    return localStorage.getItem('isMirrored') === 'true';
  });
  
  // ★ 追加: ChatScreenを強制リセットするためのキー
  const [chatKey, setChatKey] = useState<string>('new'); 

  const handleExamTypeChange = (type: 'junior-high' | 'high-school') => {
    setExamType(type);
    if (type === 'junior-high') {
      setGrade('小6');
    } else {
      setGrade('中3');
    }
    fetchSessions(type);
  };

  const fetchSessions = async (currentExamType: 'junior-high' | 'high-school') => {
    try {
      // ★ 修正: ポート番号を8080（バックエンド側）に統一し、exam_typeを渡す
      const response = await fetch(`http://localhost:8080/api/sessions?exam_type=${currentExamType}`);
      if (response.ok) {
        const data = await response.json();
        setSessions(data);
      }
    } catch (error) {
      console.error("履歴の取得に失敗しました", error);
    }
  };

  useEffect(() => {
    fetchSessions(examType);
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

    // 設定をロードしたセッションに同期
    const session = sessions.find(s => s.id === id);
    if (session) {
      if (session.exam_type) setExamType(session.exam_type as 'junior-high' | 'high-school');
      if (session.grade) setGrade(session.grade);
    }
  };

  const groupedSessions = sessions.reduce((acc, session) => {
    if (!acc[session.category]) acc[session.category] = [];
    acc[session.category].push(session);
    return acc;
  }, {} as Record<string, SessionMeta[]>);

  return (
    <div className="flex h-screen bg-gray-100 font-sans">
      <aside className="w-64 bg-gray-900 text-white flex flex-col hidden md:flex">
        <div className="p-4 border-b border-gray-700 space-y-3">
          {/* 受験切り替えトグル */}
          <div className="flex bg-gray-800 rounded-lg p-1">
            <button
              onClick={() => handleExamTypeChange('junior-high')}
              className={`flex-1 text-center py-1.5 rounded-md text-xs font-bold transition ${
                examType === 'junior-high' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              中学受験
            </button>
            <button
              onClick={() => handleExamTypeChange('high-school')}
              className={`flex-1 text-center py-1.5 rounded-md text-xs font-bold transition ${
                examType === 'high-school' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              高校受験
            </button>
          </div>

          {/* 学年選択 */}
          <div className="flex items-center justify-between text-xs px-1">
            <span className="text-gray-400">対象学年:</span>
            <select
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              className="bg-gray-800 text-white border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              {examType === 'junior-high' ? (
                <>
                  <option value="小3">小学3年</option>
                  <option value="小4">小学4年</option>
                  <option value="小5">小学5年</option>
                  <option value="小6">小学6年</option>
                </>
              ) : (
                <>
                  <option value="中1">中学1年</option>
                  <option value="中2">中学2年</option>
                  <option value="中3">中学3年</option>
                </>
              )}
            </select>
          </div>

          {/* カメラ左右反転設定 */}
          <div className="flex items-center justify-between text-xs px-1 py-1">
            <span className="text-gray-400 flex items-center">
              <FlipHorizontal className="w-3.5 h-3.5 mr-1" /> カメラ左右反転:
            </span>
            <button
              onClick={() => {
                const nextVal = !isMirrored;
                setIsMirrored(nextVal);
                localStorage.setItem('isMirrored', String(nextVal));
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                isMirrored ? 'bg-blue-600' : 'bg-gray-700'
              }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                  isMirrored ? 'translate-x-5' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <button 
            onClick={handleNewChat}
            className="w-full flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg font-bold transition"
          >
            <PlusCircle className="w-5 h-5 mr-2" /> 新規の質問
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          {(() => {
            const categoriesToShow = examType === 'junior-high'
              ? ['国語', '算数', '理科', '社会', 'その他']
              : ['国語', '数学', '理科', '社会', '英語', 'その他'];

            return categoriesToShow.map(category => {
              const catSessions = groupedSessions[category];
              if (!catSessions || catSessions.length === 0) return null;
              return (
                <div key={category} className="mb-4">
                  <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 flex items-center px-2">
                    <Folder className="w-3 h-3 mr-1" /> {category}
                  </h2>
                  <ul className="space-y-1">
                    {catSessions.map(session => (
                      <li key={session.id}>
                        <button
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
              );
            });
          })()}
        </div>
      </aside>

      <main className="flex-1 relative">
        <ChatScreen 
          // ★ 修正: activeSessionId ではなく chatKey を使うことで確実に再マウントされる
          key={chatKey} 
          initialSessionId={activeSessionId} 
          onSessionUpdate={() => fetchSessions(examType)} 
          examType={examType}
          grade={grade}
          isMirrored={isMirrored}
          onSyncSettings={(type, gr) => {
            setExamType(type);
            setGrade(gr);
          }}
        />
      </main>
    </div>
  );
}

export default App;