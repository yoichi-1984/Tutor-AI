# database.py:
import os
import uuid
from datetime import datetime
from pathlib import Path
from sqlalchemy import create_engine, Column, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

# -------------------------------------------------------------------
# データベース接続設定 (SQLite)
# -------------------------------------------------------------------
# 中学受験用と高校受験用で物理ファイルを分離
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

SQLALCHEMY_DATABASE_URL_JH = f"sqlite:///{DATA_DIR}/chat_history_junior_high.db"
SQLALCHEMY_DATABASE_URL_HS = f"sqlite:///{DATA_DIR}/chat_history_high_school.db"

# SQLite固有の設定（別スレッドからのアクセス許可）
engine_jh = create_engine(
    SQLALCHEMY_DATABASE_URL_JH, connect_args={"check_same_thread": False}
)
engine_hs = create_engine(
    SQLALCHEMY_DATABASE_URL_HS, connect_args={"check_same_thread": False}
)

SessionLocalJH = sessionmaker(autocommit=False, autoflush=False, bind=engine_jh)
SessionLocalHS = sessionmaker(autocommit=False, autoflush=False, bind=engine_hs)

Base = declarative_base()

# -------------------------------------------------------------------
# テーブル定義 (2階層モデル)
# -------------------------------------------------------------------

class ChatSession(Base):
    """
    第1階層: セッション（会話のまとまり）を管理するテーブル
    """
    __tablename__ = "sessions"

    # UUIDを主キーとして使用
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))

    # ルーターAIが判定した大分類
    category = Column(String, index=True, nullable=False)

    # 最初の質問から自動生成される見出し（UI表示用）
    title = Column(String, nullable=False)

    # 受験タイプ ("junior-high" | "high-school")
    exam_type = Column(String, nullable=True, default="junior-high")

    # 対象学年 (例: "小6", "中3")
    grade = Column(String, nullable=True, default="小6")

    created_at = Column(DateTime, default=datetime.utcnow)

    # 第2階層（Message）とのリレーション（1対多）
    messages = relationship("Message", back_populates="session", cascade="all, delete-orphan")


class Message(Base):
    """
    第2階層: 実際のやり取り（チャットログ）を管理するテーブル
    """
    __tablename__ = "messages"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id = Column(String, ForeignKey("sessions.id"), nullable=False)

    # "user" または "model"
    role = Column(String, nullable=False)

    # 発話内容のテキスト
    text_content = Column(Text, nullable=False)

    # 生成された音声ファイルのパス（AIの応答の場合）
    audio_file_path = Column(String, nullable=True)

    # ユーザーが送信した画像ファイルのパス（画像＋音声パターンの場合）
    image_file_path = Column(String, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    # 第1階層（ChatSession）とのリレーション
    session = relationship("ChatSession", back_populates="messages")

# -------------------------------------------------------------------
# データベース初期化と依存性注入
# -------------------------------------------------------------------
def init_db():
    """
    テーブルが存在しない場合に作成する。
    main.py の起動時などに呼び出す。
    """
    from sqlalchemy import text
    Base.metadata.create_all(bind=engine_jh)
    Base.metadata.create_all(bind=engine_hs)
    
    # 既存のテーブルに対して新カラムが存在するかチェックし、なければ追加する
    for name, engine_obj in [("junior_high", engine_jh), ("high_school", engine_hs)]:
        with engine_obj.connect() as conn:
            result = conn.execute(text("PRAGMA table_info(sessions)"))
            columns = [row[1] for row in result.fetchall()]
            
            if "exam_type" not in columns:
                try:
                    conn.execute(text("ALTER TABLE sessions ADD COLUMN exam_type VARCHAR DEFAULT 'junior-high'"))
                    conn.commit()
                    print(f"[{name}] Added column 'exam_type' to 'sessions' table.")
                except Exception as e:
                    print(f"[{name}] Error adding column 'exam_type': {e}")
                    
            if "grade" not in columns:
                try:
                    conn.execute(text("ALTER TABLE sessions ADD COLUMN grade VARCHAR DEFAULT '小6'"))
                    conn.commit()
                    print(f"[{name}] Added column 'grade' to 'sessions' table.")
                except Exception as e:
                    print(f"[{name}] Error adding column 'grade': {e}")

def get_db():
    """
    デフォルトとして中学受験DBのセッションを返す
    """
    db = SessionLocalJH()
    try:
        yield db
    finally:
        db.close()

def find_session_and_db(session_id: str):
    """
    セッションIDをもとに、中学受験DBと高校受験DBのいずれかから
    セッションオブジェクトを取得し、セッションオブジェクトとDBセッションのペアを返す。
    """
    # 1. 中学受験DBを探す
    db_jh = SessionLocalJH()
    session = db_jh.query(ChatSession).filter(ChatSession.id == session_id).first()
    if session:
        return session, db_jh
    db_jh.close()

    # 2. 高校受験DBを探す
    db_hs = SessionLocalHS()
    session = db_hs.query(ChatSession).filter(ChatSession.id == session_id).first()
    if session:
        return session, db_hs
    db_hs.close()

    return None, None