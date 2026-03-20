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
# backend/data/ ディレクトリに chat_history.db を作成
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DATA_DIR}/chat_history.db"

# SQLite固有の設定（別スレッドからのアクセス許可）
engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

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

    # ルーターAIが判定した大分類 (例: "電池設計", "正極", "負極", "電解液", "その他")
    category = Column(String, index=True, nullable=False)

    # 最初の質問から自動生成される見出し（UI表示用）
    title = Column(String, nullable=False)

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
    Base.metadata.create_all(bind=engine)

def get_db():
    """
    FastAPIの Dependency Injection 用。
    リクエストごとにDBセッションを作成し、終わったら閉じる。
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()