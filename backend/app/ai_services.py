# ai_services.py:
import os
import json
import yaml
from pathlib import Path
from google import genai
from google.genai import types
from google.cloud import texttospeech

# -------------------------------------------------------------------
# パス解決と外部ファイル読み込み
# -------------------------------------------------------------------
# 現在のファイル(ai_services.py)を基準にパスを解決
APP_DIR = Path(__file__).resolve().parent
BASE_DIR = APP_DIR.parent

CREDENTIALS_PATH = BASE_DIR / "env" / "api.json"
PROMPTS_PATH = APP_DIR / "prompts.yaml"

# 1. GCP認証情報から PROJECT_ID を自動取得
if not CREDENTIALS_PATH.exists():
    raise FileNotFoundError(f"GCP認証ファイルが見つかりません: {CREDENTIALS_PATH}")

with open(CREDENTIALS_PATH, "r", encoding="utf-8") as f:
    gcp_credentials = json.load(f)
    PROJECT_ID = gcp_credentials.get("project_id")
    if not PROJECT_ID:
        raise ValueError("api.json に project_id が含まれていません。")

# 環境変数に認証ファイルのパスをセット（SDKが自動で読み込むため）
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(CREDENTIALS_PATH)

# 2. YAMLからプロンプトを読み込み
with open(PROMPTS_PATH, "r", encoding="utf-8") as f:
    prompts = yaml.safe_load(f)

# -------------------------------------------------------------------
# 初期化処理 (GCP Vertex AI)
# -------------------------------------------------------------------
LOCATION = "global"

# Vertex AIとして実行するため vertexai=True を指定
client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)

ROUTER_MODEL = "gemini-3.1-flash-lite"
MAIN_MODEL = "gemini-3.1-flash-lite"
#gemini-3.1-pro-preview

# -------------------------------------------------------------------
# 1. ルーターAI (ドメイン判定 & 自動カテゴライズ)
# -------------------------------------------------------------------
def check_domain_and_categorize(text: str, image_bytes_list: list = None, exam_type: str = "junior-high") -> dict:
    categories = ["国語", "算数", "理科", "社会", "その他"] if exam_type == "junior-high" else ["国語", "数学", "理科", "社会", "英語", "その他"]
    schema = {
        "type": "OBJECT",
        "properties": {
            "is_subject_related": {"type": "BOOLEAN"},
            "category": {
                "type": "STRING",
                "enum": categories
            },
            "title": {  # ★この項目を追加
                "type": "STRING", 
                "description": "質問の要約タイトル（10文字程度）"
            },
            "reason": {"type": "STRING", "description": "判定理由を簡潔に"}
        },
        "required": ["is_subject_related", "category", "title", "reason"] # ★titleを必須に追加
    }

    contents = []
    if image_bytes_list:
        for img_bytes in image_bytes_list:
            contents.append(types.Part.from_bytes(data=img_bytes, mime_type="image/jpeg"))

    exam_type_str = "中学受験" if exam_type == "junior-high" else "高校受験"
    system_prompt_formatted = prompts['router_ai']['system_prompt'].format(exam_type=exam_type_str)
    router_prompt = f"{system_prompt_formatted}\nユーザーの質問: {text}"
    contents.append(router_prompt)

    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=schema,
        temperature=0.0
    )

    response = client.models.generate_content(
        model=ROUTER_MODEL,
        contents=contents,
        config=config
    )

    return json.loads(response.text)

# -------------------------------------------------------------------
# 2. メインAI (回答のストリーミング生成)
# -------------------------------------------------------------------
def generate_answer_stream(text: str, image_bytes_list: list = None, chat_history: list = None, exam_type: str = "junior-high", grade: str = "小6", explanation_level: str = "detail"):
    contents = []

    if chat_history:
        for msg in chat_history:
            contents.append(types.Content(role=msg["role"], parts=[types.Part.from_text(text=msg["text"])]))

    # ★ 複数の画像をループで追加
    if image_bytes_list:
        for img_bytes in image_bytes_list:
            contents.append(types.Part.from_bytes(data=img_bytes, mime_type="image/jpeg"))

    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=text)]))

    exam_type_str = "中学受験" if exam_type == "junior-high" else "高校受験"
    explanation_inst = prompts['main_ai']['explanation_instructions'].get(explanation_level, "")
    system_instruction_formatted = prompts['main_ai']['system_instruction'].format(
        exam_type=exam_type_str,
        grade=grade,
        explanation_instruction=explanation_inst
    )

    config = types.GenerateContentConfig(
        temperature=0.2,
        system_instruction=system_instruction_formatted,
        tools=[{"google_search": {}}],
        thinking_config={"thinking_level": "low"}
    )

    response_stream = client.models.generate_content_stream(
        model=MAIN_MODEL,
        contents=contents,
        config=config
    )

    for chunk in response_stream:
        if chunk.text:
            yield chunk.text

# -------------------------------------------------------------------
# 3. 音声合成 (非同期 TTS)
# -------------------------------------------------------------------
async def generate_speech_chunk_async(text: str) -> bytes:
    client_tts = texttospeech.TextToSpeechAsyncClient()
    synthesis_input = texttospeech.SynthesisInput(text=text)
    voice = texttospeech.VoiceSelectionParams(language_code="ja-JP", name="ja-JP-Neural2-B")
    audio_config = texttospeech.AudioConfig(audio_encoding=texttospeech.AudioEncoding.MP3, speaking_rate=1.1)

    response = await client_tts.synthesize_speech(
        input=synthesis_input, voice=voice, audio_config=audio_config
    )
    return response.audio_content