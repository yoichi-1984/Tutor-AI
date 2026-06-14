# main.py:
import os
import re
import json
import yaml
import uuid
from typing import List
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
# Note: Ensure sqlalchemy is installed and database.py is correctly set up
from sqlalchemy.orm import Session
from google.cloud import speech

# backend/app/main.py (16行目付近)
from .ai_services import (check_domain_and_categorize,generate_answer_stream,generate_speech_chunk_async)
from .database import init_db, get_db, SessionLocalJH, SessionLocalHS, ChatSession, Message, find_session_and_db

# -------------------------------------------------------------------
# アプリケーション初期化とディレクトリ設定
# -------------------------------------------------------------------
# 設定ファイル (default.yaml) のパス
CONFIG_PATH = Path(__file__).resolve().parent.parent.parent / "default.yaml"

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
USER_AUDIO_DIR = DATA_DIR / "user_audio"
USER_IMAGE_DIR = DATA_DIR / "user_images"
AI_AUDIO_DIR = DATA_DIR / "ai_audio"

# 保存用ディレクトリの作成
for d in [USER_AUDIO_DIR, USER_IMAGE_DIR, AI_AUDIO_DIR]:
    d.mkdir(parents=True, exist_ok=True)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # アプリ起動時にデータベースのテーブルを作成
    init_db()
    yield

app = FastAPI(title="Tutor API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------------------------------------------------
# ユーティリティ: 音声認識 (STT)
# -------------------------------------------------------------------
async def transcribe_audio(audio_bytes: bytes) -> str:
    client = speech.SpeechAsyncClient()
    audio = speech.RecognitionAudio(content=audio_bytes)
    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
        sample_rate_hertz=48000,
        language_code="ja-JP",
    )
    response = await client.recognize(config=config, audio=audio)
    if not response.results:
        return ""
    return "".join([result.alternatives[0].transcript for result in response.results])

# -------------------------------------------------------------------
# 1. APIエンドポイント: チャット処理 (AI推論 & DB保存)
# -------------------------------------------------------------------
@app.post("/api/chat")
async def chat_endpoint(
    audio_file: UploadFile = File(...),
    image_files: List[UploadFile] = File(None),
    session_id: str = Form(None),
    exam_type: str = Form(None),
    grade: str = Form(None),
    explanation_level: str = Form(None),
):
    db = None
    try:
        # 1. ファイルの読み込みとローカル保存
        audio_bytes = await audio_file.read()
        user_audio_filename = f"{uuid.uuid4()}.webm"
        with open(USER_AUDIO_DIR / user_audio_filename, "wb") as f:
            f.write(audio_bytes)

# ★ 画像の複数保存処理
        image_bytes_list = []
        image_filenames = []
        if image_files:
            for img_file in image_files:
                # 空のファイルが送られてきた場合はスキップ
                if not img_file.filename:
                    continue
                b = await img_file.read()
                image_bytes_list.append(b)
                
                fname = f"{uuid.uuid4()}.jpg"
                image_filenames.append(fname)
                with open(USER_IMAGE_DIR / fname, "wb") as f:
                    f.write(b)

        # 2. 音声認識 (STT)
        user_text = await transcribe_audio(audio_bytes)
        print(f"\n【認識した音声】: {user_text}\n") # ★追加: デバッグ用コンソール出力

        if not user_text:
            raise HTTPException(status_code=400, detail="音声を認識できませんでした。")

        # 決定された設定値 (デフォルトは junior-high, 小6)
        active_exam_type = exam_type or "junior-high"
        active_grade = grade or "小6"
        active_explanation_level = explanation_level or "detail"

        chat_session = None
        if session_id:
            # 既存セッションからDBとセッションを自動検出
            chat_session, db = find_session_and_db(session_id)
            if chat_session:
                if chat_session.exam_type:
                    active_exam_type = chat_session.exam_type
                if chat_session.grade:
                    active_grade = chat_session.grade

        # 新規セッションの場合は、対応するDBを使用
        if not db:
            if active_exam_type == "high-school":
                db = SessionLocalHS()
            else:
                db = SessionLocalJH()

        # 3. ルーターAI判定
        router_result = check_domain_and_categorize(user_text, image_bytes_list, exam_type=active_exam_type)
        if not router_result.get("is_subject_related"):
            exam_name = "中学受験" if active_exam_type == "junior-high" else "高校受験"
            return JSONResponse(
                status_code=200, 
                content={
                    "status": "rejected",
                    "reason": router_result.get("reason"),
                    "message": f"私は{exam_name}の家庭教師です。専門外の質問にはお答えできません。"
                }
            )

        # 4. セッションと履歴の管理 (DB)
        # 新規セッションの場合は作成
        if not chat_session:
            # ルーターAIが生成した短いタイトルを取得（万が一無い場合は"新規チャット"）
            ai_generated_title = router_result.get("title", "新規チャット")

            chat_session = ChatSession(
                category=router_result.get("category"),
                title=ai_generated_title,
                exam_type=active_exam_type,
                grade=active_grade
            )
            db.add(chat_session)
            db.commit()
            db.refresh(chat_session)
            session_id = chat_session.id

        # 過去の履歴を取得し、Geminiの形式に整形
        db_messages = db.query(Message).filter(Message.session_id == session_id).order_by(Message.created_at).all()
        chat_history = [{"role": m.role, "text": m.text_content} for m in db_messages]

        # ユーザーの発話をDBに保存
        user_image_paths_str = ",".join(image_filenames) if image_filenames else None
        
        user_msg = Message(
            session_id=session_id,
            role="user",
            text_content=user_text,
            audio_file_path=user_audio_filename,
            image_file_path=user_image_paths_str # ★ カンマ区切りの文字列を保存
        )
        db.add(user_msg)
        db.commit()

        # 5. ストリーミング応答とAIの保存 (SSE)
        async def event_generator():
            init_data = {
                "type": "meta", 
                "session_id": session_id,
                "user_text": user_text,
                "category": router_result.get("category"),
                "exam_type": active_exam_type,
                "grade": active_grade
            }
            yield f"data: {json.dumps(init_data)}\n\n"

            full_text = ""
            # ai_services のストリーミング関数を呼び出し（履歴を渡す）
            for chunk in generate_answer_stream(
                user_text, 
                image_bytes_list, 
                chat_history, 
                exam_type=active_exam_type, 
                grade=active_grade,
                explanation_level=active_explanation_level
            ):
                full_text += chunk
                yield f"data: {json.dumps({'type': 'text', 'content': chunk})}\n\n"

            # TTSの生成 (5000文字制限を回避するための分割処理)
            # Markdownの記号や出典リンクを除去し、読み上げ用のクリーンなテキストを作成
            cleaned_text = re.sub(r'\[\d+\]', '', full_text) # 出典リンク除去
            cleaned_text = re.sub(r'[*_#`]', '', cleaned_text) # Markdown記号の除去
            cleaned_text = cleaned_text.replace('\n', '。').strip() # 改行を句点に

            # 文章を句点(。)で分割し、空の要素を弾く
            sentences = [s + '。' for s in cleaned_text.split('。') if s.strip()]

            # 分割したテキストを一つずつ音声化し、バイナリを結合していく
            final_audio_content = b''
            current_chunk = ""

            for sentence in sentences:
                # チャンクが長くなりすぎないように結合（約1000文字を目安）
                if len(current_chunk) + len(sentence) < 1000:
                    current_chunk += sentence
                else:
                    if current_chunk:
                        chunk_audio = await generate_speech_chunk_async(current_chunk)
                        final_audio_content += chunk_audio
                    current_chunk = sentence

            # 最後の余ったチャンクを音声化
            if current_chunk:
                chunk_audio = await generate_speech_chunk_async(current_chunk)
                final_audio_content += chunk_audio

            ai_audio_filename = f"{uuid.uuid4()}.mp3"
            with open(AI_AUDIO_DIR / ai_audio_filename, "wb") as f:
                f.write(final_audio_content)

            # ストリーミング後に別セッションを開いてAIの回答をDBに保存
            SessionLocalClass = SessionLocalHS if active_exam_type == "high-school" else SessionLocalJH
            with SessionLocalClass() as stream_db:
                ai_msg = Message(
                    session_id=session_id,
                    role="model",
                    text_content=full_text,
                    audio_file_path=ai_audio_filename
                )
                stream_db.add(ai_msg)
                stream_db.commit()

            yield f"data: {json.dumps({'type': 'audio', 'url': f'/api/files/ai_audio/{ai_audio_filename}'})}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(event_generator(), media_type="text/event-stream")

    except Exception as e:
        print(f"\n【エラー発生】: {str(e)}\n") # ★追加: 例外発生時にもコンソールに出力
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if db:
            db.close()

# -------------------------------------------------------------------
# 2. APIエンドポイント: セッション履歴の取得
# -------------------------------------------------------------------
@app.get("/api/sessions")
def get_all_sessions(exam_type: str = "junior-high"):
    """全セッションを新着順で取得（サイドバー表示用）"""
    db = SessionLocalHS() if exam_type == "high-school" else SessionLocalJH()
    try:
        sessions = db.query(ChatSession).order_by(ChatSession.created_at.desc()).all()
        return [
            {
                "id": s.id,
                "category": s.category,
                "title": s.title,
                "exam_type": s.exam_type,
                "grade": s.grade,
                "created_at": s.created_at.isoformat() if s.created_at else None
            }
            for s in sessions
        ]
    finally:
        db.close()

@app.get("/api/sessions/{session_id}")
def get_session_history(session_id: str):
    """特定のセッションのチャット履歴をすべて取得（再開用）"""
    session, db = find_session_and_db(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        messages = db.query(Message).filter(Message.session_id == session_id).order_by(Message.created_at).all()
        
        session_dict = {
            "id": session.id,
            "category": session.category,
            "title": session.title,
            "exam_type": session.exam_type,
            "grade": session.grade,
            "created_at": session.created_at.isoformat() if session.created_at else None
        }
        
        messages_list = [
            {
                "id": m.id,
                "session_id": m.session_id,
                "role": m.role,
                "text_content": m.text_content,
                "audio_file_path": m.audio_file_path,
                "image_file_path": m.image_file_path,
                "created_at": m.created_at.isoformat() if m.created_at else None
            }
            for m in messages
        ]
        
        return {
            "session": session_dict,
            "messages": messages_list
        }
    finally:
        if db:
            db.close()

# -------------------------------------------------------------------
# 3. APIエンドポイント: メディアファイルの配信
# -------------------------------------------------------------------
@app.get("/api/files/{file_type}/{filename}")
async def get_file(file_type: str, filename: str):
    """保存された画像や音声をフロントエンドに返す"""
    if file_type == "ai_audio":
        path = AI_AUDIO_DIR / filename
        media_type = "audio/mpeg"
    elif file_type == "user_audio":
        path = USER_AUDIO_DIR / filename
        media_type = "audio/webm"
    elif file_type == "user_images":
        path = USER_IMAGE_DIR / filename
        media_type = "image/jpeg"
    else:
        raise HTTPException(status_code=400, detail="Invalid file type")

    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(path, media_type=media_type)

# -------------------------------------------------------------------
# 4. APIエンドポイント: 設定の保存と取得
# -------------------------------------------------------------------
@app.get("/api/config")
async def get_config():
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
                return data if data else {
                    "exam_type": "junior-high",
                    "grade": "小6",
                    "is_mirrored": False
                }
        except Exception:
            pass
    return {
        "exam_type": "junior-high",
        "grade": "小6",
        "is_mirrored": False
    }

@app.post("/api/config")
async def update_config(config: dict):
    try:
        current_config = {
            "exam_type": "junior-high",
            "grade": "小6",
            "is_mirrored": False
        }
        if CONFIG_PATH.exists():
            try:
                with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                    data = yaml.safe_load(f)
                    if data:
                        current_config.update(data)
            except Exception:
                pass
        
        current_config.update(config)
        
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            yaml.safe_dump(current_config, f, allow_unicode=True, default_flow_style=False)
            
        return {"status": "success", "config": current_config}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))