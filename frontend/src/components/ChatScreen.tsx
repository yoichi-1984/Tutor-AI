import React, { useState, useRef, useEffect } from 'react';
import Webcam from 'react-webcam';
import { Mic, Camera, Send, RefreshCw, VolumeX, XCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

// --- 型定義 ---
type Message = {
  id: string;
  role: 'user' | 'model';
  text: string;
  imageUrls?: string[]; // ★ 複数の画像を扱えるように配列に変更
};

type InputMode = 'IDLE' | 'CAMERA' | 'IMAGE_CONFIRM' | 'RECORDING_AUDIO' | 'PROCESSING';

type ChatScreenProps = {
  initialSessionId: string | null;
  onSessionUpdate?: () => void;
  examType: 'junior-high' | 'high-school'; // ★ 追加
  grade: string; // ★ 追加
  isMirrored?: boolean; // ★ 追加
  onSyncSettings?: (examType: 'junior-high' | 'high-school', grade: string) => void; // ★ 追加
};

export const ChatScreen: React.FC<ChatScreenProps> = ({ 
  initialSessionId, 
  onSessionUpdate,
  examType,
  grade,
  isMirrored = true,
  onSyncSettings
}) => {
  // --- 状態管理 ---
  const [messages, setMessages] = useState<Message[]>([]);
  const [mode, setMode] = useState<InputMode>('IDLE');
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);

  // メディア関連の状態
  const [capturedImages, setCapturedImages] = useState<string[]>([]); // ★ 複数画像用のState
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [explanationLevel, setExplanationLevel] = useState<'detail' | 'hint'>('detail');

  // 参照 (Refs)
  const webcamRef = useRef<Webcam>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const aiAudioRef = useRef<HTMLAudioElement | null>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // --- 過去の履歴のロード ---
  useEffect(() => {
    if (initialSessionId) {
      const loadHistory = async () => {
        try {
          // ★ 修正: ポート番号を8080に変更
          const res = await fetch(`http://localhost:8080/api/sessions/${initialSessionId}`);
          if (res.ok) {
            const data = await res.json();

            // 親コンポーネントの設定と同期
            if (data.session && onSyncSettings) {
              const sType = data.session.exam_type as 'junior-high' | 'high-school';
              const sGrade = data.session.grade;
              if (sType && sGrade) {
                onSyncSettings(sType, sGrade);
              }
            }

            const formattedMessages: Message[] = data.messages.map((m: any) => ({
              id: m.id,
              role: m.role,
              text: m.text_content,
              // ★ カンマ区切りの文字列を配列にしてURLを生成
              imageUrls: m.image_file_path 
                ? m.image_file_path.split(',').map((name: string) => `http://localhost:8080/api/files/user_images/${name}`) 
                : undefined
            }));
            setMessages(formattedMessages);
          }
        } catch (error) {
          console.error("履歴のロードに失敗しました", error);
        }
      };
      loadHistory();
    }
  }, [initialSessionId]);

  // --- 自動スクロール ---
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // --- UI操作ハンドラー ---

  // IDLE状態から最初にカメラを起動するとき（画像をリセット）
  const handleStartCameraFromIdle = () => {
    stopAiAudio(); // ★ 自動停止
    setCapturedImages([]);
    setMode('CAMERA');
  };

  // 1枚撮ったあとに「追加撮影」するとき（画像を維持）
  const handleAddMoreCamera = () => {
    stopAiAudio(); // ★ 自動停止
    setMode('CAMERA');
  };

  const handleCaptureImage = () => {
    const imageSrc = webcamRef.current?.getScreenshot();
    if (imageSrc) {
      setCapturedImages(prev => [...prev, imageSrc]); // ★ 配列に追加
      setMode('IMAGE_CONFIRM');
    }
  };

  const handleResetImages = () => {
    setCapturedImages([]);
    setMode('CAMERA');
  };

  const handleStartRecording = async () => {
    stopAiAudio(); // ★ 自動停止
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.start();
      setMode('RECORDING_AUDIO');
    } catch (err) {
      console.error("マイクへのアクセスが拒否されました", err);
      alert("マイクの利用を許可してください。");
    }
  };

  const handleStopAndSend = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        sendToBackend(audioBlob, capturedImages); // ★ 複数画像を渡す
      };
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
  };

  // ★ 追加: 入力キャンセル処理
  const handleCancel = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.onstop = null; // 送信トリガーを解除
      if (mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      if (mediaRecorderRef.current.stream) {
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
    }
    setMode('IDLE');
    setCapturedImages([]);
  };

  // --- API通信 (FastAPIとのSSEストリーミング処理) ---
  const sendToBackend = async (audioBlob: Blob, imagesBase64: string[]) => {
    setMode('PROCESSING');

    const userMsgId = Date.now().toString();
    setMessages(prev => [...prev, {
      id: userMsgId, 
      role: 'user', 
      text: '（音声を解析中...）', 
      imageUrls: imagesBase64.length > 0 ? imagesBase64 : undefined
    }]);

    const formData = new FormData();
    formData.append('audio_file', audioBlob, 'voice.webm');

    // ★ 複数の画像をFormDataに追加
    for (let i = 0; i < imagesBase64.length; i++) {
      const res = await fetch(imagesBase64[i]);
      const imageBlob = await res.blob();
      // backendは `image_files` というキー名でリストを受け取る
      formData.append('image_files', imageBlob, `image_${i}.jpg`);
    }

    if (sessionId) formData.append('session_id', sessionId);
    formData.append('exam_type', examType);
    formData.append('grade', grade);
    formData.append('explanation_level', explanationLevel);

    try {
      const response = await fetch('http://localhost:8080/api/chat', {
        method: 'POST',
        body: formData,
      });

      // JSON（専門外などで弾かれた場合）の処理
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const errorData = await response.json();

        setMessages(prev => prev.map(m => 
          m.id === userMsgId ? { ...m, text: '（判定により中断）' } : m
        ));

        const aiMsgId = (Date.now() + 1).toString();
        setMessages(prev => [...prev, { 
          id: aiMsgId, 
          role: 'model', 
          text: `⚠️ ${errorData.message}\n(理由: ${errorData.reason || '専門外'})` 
        }]);

        setMode('IDLE');
        setCapturedImages([]);
        return; 
      }

      if (!response.body) throw new Error('ReadableStream not supported.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let aiText = "";
      const aiMsgId = (Date.now() + 1).toString();

      setMessages(prev => [...prev, { id: aiMsgId, role: 'model', text: '' }]);

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || ""; 

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.substring(6);
            if (dataStr === '[DONE]') continue;

            const data = JSON.parse(dataStr);

            if (data.type === 'meta') {
              setMessages(prev => prev.map(m => 
                m.id === userMsgId ? { ...m, text: data.user_text } : m
              ));
              if (data.session_id && !sessionId) setSessionId(data.session_id);
              
              if (data.exam_type && data.grade && onSyncSettings) {
                onSyncSettings(data.exam_type, data.grade);
              }
            } 

            else if (data.type === 'text') {
              aiText += data.content;
              setMessages(prev => prev.map(m => 
                m.id === aiMsgId ? { ...m, text: aiText } : m
              ));
            } 
            else if (data.type === 'audio') {
              playAiAudio(`http://localhost:8080${data.url}`);
            }
          }
        }
      }
    } catch (error) {
      console.error("API通信エラー", error);
      alert("通信エラーが発生しました。");
    } finally {
      setMode('IDLE');
      setCapturedImages([]);
      if (onSessionUpdate) onSessionUpdate();
    }
  };

  // --- 音声再生コントロール ---
  const playAiAudio = (url: string) => {
    if (aiAudioRef.current) {
      aiAudioRef.current.pause();
    }
    const audio = new Audio(url);
    aiAudioRef.current = audio;

    audio.onplay = () => setIsPlayingAudio(true);
    audio.onended = () => setIsPlayingAudio(false);
    audio.onpause = () => setIsPlayingAudio(false);

    audio.play();
  };

  const stopAiAudio = () => {
    if (aiAudioRef.current) {
      aiAudioRef.current.pause();
      setIsPlayingAudio(false);
    }
  };

  // --- レンダリング ---
  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto bg-gray-50 font-sans">
      <header className="bg-blue-600 text-white p-4 text-center shadow-md flex justify-between items-center">
        <h1 className="text-xl font-bold">家庭教師AI</h1>
        {isPlayingAudio && (
          <button onClick={stopAiAudio} className="flex items-center bg-red-500 hover:bg-red-600 px-3 py-1 rounded-full text-sm font-bold transition">
            <VolumeX className="w-4 h-4 mr-1" /> 音声停止
          </button>
        )}
      </header>

      <main className="flex-1 overflow-y-auto p-4 space-y-6">
        {messages.length === 0 ? (
          <div className="text-center text-gray-400 mt-20">
            <p>画面下のボタンから、音声または画像で質問してください。</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl p-4 shadow-sm ${msg.role === 'user' ? 'bg-blue-100 text-blue-900' : 'bg-white border text-gray-800'}`}>
                {msg.role === 'model' && <div className="font-bold text-blue-600 text-xs mb-1">先生AI</div>}
                
                {/* ★ 複数画像の表示 */}
                {msg.imageUrls && msg.imageUrls.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {msg.imageUrls.map((url, idx) => (
                      <img key={idx} src={url} alt={`Uploaded ${idx}`} className="max-w-[200px] h-auto rounded-lg border" />
                    ))}
                  </div>
                )}
                
                <div className="whitespace-pre-wrap leading-relaxed markdown-content">
                  <ReactMarkdown
                    remarkPlugins={[remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                  >
                    {msg.text}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={chatBottomRef} />
      </main>

      <footer className="bg-white border-t p-4 pb-8">
        {/* ★ 読み上げ中の停止バナーをフッター最上部に配置 */}
        {isPlayingAudio && (
          <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4 max-w-md mx-auto shadow-sm">
            <span className="text-xs text-blue-800 font-bold flex items-center">
              <span className="w-2.5 h-2.5 bg-blue-600 rounded-full mr-2 animate-ping"></span>
              AIが回答を読み上げています...
            </span>
            <button 
              onClick={stopAiAudio}
              className="flex items-center bg-red-500 hover:bg-red-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition shadow"
            >
              <VolumeX className="w-3.5 h-3.5 mr-1" /> 読み上げ停止
            </button>
          </div>
        )}

        {/* ★ 解説レベルトグルスイッチ */}
        {mode !== 'PROCESSING' && (
          <div className="flex justify-center mb-4">
            <div className="bg-gray-100 p-1 rounded-xl flex gap-1 border border-gray-200 shadow-inner">
              <button
                onClick={() => setExplanationLevel('detail')}
                className={`px-4 py-1.5 rounded-lg text-xs font-bold flex items-center transition-all cursor-pointer ${
                  explanationLevel === 'detail'
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                📖 くわしく解説
              </button>
              <button
                onClick={() => setExplanationLevel('hint')}
                className={`px-4 py-1.5 rounded-lg text-xs font-bold flex items-center transition-all cursor-pointer ${
                  explanationLevel === 'hint'
                    ? 'bg-amber-500 text-white shadow'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                💡 ヒントだけ
              </button>
            </div>
          </div>
        )}

        {mode === 'IDLE' && (
          <div className="flex justify-center gap-4">
            <button onClick={handleStartRecording} className="flex flex-col items-center justify-center bg-blue-500 hover:bg-blue-600 text-white rounded-2xl w-32 h-24 transition shadow-lg">
              <Mic className="w-8 h-8 mb-2" />
              <span className="font-bold">質問する<br/>(音声のみ)</span>
            </button>
            <button onClick={handleStartCameraFromIdle} className="flex flex-col items-center justify-center bg-emerald-500 hover:bg-emerald-600 text-white rounded-2xl w-32 h-24 transition shadow-lg">
              <Camera className="w-8 h-8 mb-2" />
              <span className="font-bold">画像と質問<br/>(カメラ起動)</span>
            </button>
          </div>
        )}

        {mode === 'CAMERA' && (
          <div className="flex flex-col items-center gap-4 w-full max-w-md mx-auto">
            <div className="relative w-full rounded-lg overflow-hidden border-4 border-emerald-500">
              <Webcam 
                audio={false} 
                ref={webcamRef} 
                screenshotFormat="image/jpeg" 
                videoConstraints={{ facingMode: "environment" }} 
                mirrored={isMirrored} 
                className="w-full h-auto"
              />
            </div>
            <div className="flex gap-4 w-full justify-center">
              <button 
                onClick={handleCancel} 
                className="bg-gray-500 hover:bg-gray-600 text-white px-6 py-3 rounded-full font-bold shadow-lg flex items-center justify-center transition cursor-pointer"
              >
                <XCircle className="mr-2 w-5 h-5" /> キャンセル
              </button>
              <button 
                onClick={handleCaptureImage} 
                className="bg-emerald-500 hover:bg-emerald-600 text-white px-8 py-3 rounded-full font-bold shadow-lg flex items-center justify-center flex-1 transition cursor-pointer"
              >
                <Camera className="mr-2" /> 撮影する
              </button>
            </div>
          </div>
        )}

        {mode === 'IMAGE_CONFIRM' && capturedImages.length > 0 && (
          <div className="flex flex-col items-center gap-4 w-full">
            {/* ★ 撮影した複数の画像を横並びでプレビュー */}
            <div className="flex gap-2 overflow-x-auto p-2 w-full max-w-md">
              {capturedImages.map((src, idx) => (
                <img key={idx} src={src} alt={`Captured ${idx}`} className="h-32 w-auto rounded-lg border-2 border-gray-300 object-contain" />
              ))}
            </div>
            
            <div className="flex flex-wrap justify-center gap-3">
              <button 
                onClick={handleCancel} 
                className="bg-red-500 hover:bg-red-600 text-white px-4 py-3 rounded-full font-bold flex items-center text-sm shadow transition cursor-pointer"
              >
                <XCircle className="mr-1 w-4 h-4" /> キャンセル
              </button>
              <button 
                onClick={handleAddMoreCamera} 
                className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-3 rounded-full font-bold flex items-center text-sm shadow transition cursor-pointer"
              >
                <Camera className="mr-1 w-4 h-4" /> 追加撮影
              </button>
              <button 
                onClick={handleResetImages} 
                className="bg-gray-500 hover:bg-gray-600 text-white px-4 py-3 rounded-full font-bold flex items-center text-sm shadow transition cursor-pointer"
              >
                <RefreshCw className="mr-1 w-4 h-4" /> 撮り直す
              </button>
              <button 
                onClick={handleStartRecording} 
                className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-3 rounded-full font-bold flex items-center text-sm shadow transition cursor-pointer"
              >
                <Mic className="mr-1 w-4 h-4" /> 音声で質問
              </button>
            </div>
          </div>
        )}

        {mode === 'RECORDING_AUDIO' && (
          <div className="flex flex-col items-center gap-4 w-full max-w-md mx-auto">
            <div className="text-red-500 font-bold animate-pulse flex items-center">
              <div className="w-3 h-3 bg-red-500 rounded-full mr-2"></div> 録音中... お話しください
            </div>
            <div className="flex gap-4 w-full justify-center">
              <button 
                onClick={handleCancel} 
                className="bg-gray-500 hover:bg-gray-600 text-white px-6 py-4 rounded-xl font-bold shadow-lg flex items-center justify-center transition cursor-pointer"
              >
                <XCircle className="mr-2 w-5 h-5" /> キャンセル
              </button>
              <button 
                onClick={handleStopAndSend} 
                className="bg-blue-600 hover:bg-blue-700 text-white flex-1 py-4 rounded-xl font-bold flex justify-center items-center shadow-lg transition cursor-pointer"
              >
                <Send className="mr-2" /> 音声送信
              </button>
            </div>
          </div>
        )}

        {mode === 'PROCESSING' && (
          <div className="flex justify-center items-center py-6 text-gray-500 font-bold">
            <RefreshCw className="w-6 h-6 animate-spin mr-2" />
            先生が考えています...
          </div>
        )}
      </footer>
    </div>
  );
};