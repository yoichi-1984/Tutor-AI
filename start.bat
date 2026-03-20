@echo off
chcp 65001 > nul
echo 家庭教師AIのシステムを起動しています...

REM 1. バックエンドの起動 (新しいコマンドプロンプトを開いて実行)
REM ※ルートディレクトリの env をアクティベートしてから backend フォルダで uvicorn を起動します
start "TutorAI Backend" cmd /k "call env\Scripts\activate && cd backend && uvicorn app.main:app --reload --port 8080"

REM 2. フロントエンドの起動 (新しいコマンドプロンプトを開いて実行)
start "TutorAI Frontend" cmd /k "cd frontend && npm run dev"

echo 起動コマンドを送信しました。
echo ※終了する際は、開いた2つの黒い画面(ターミナル)をそれぞれ閉じてください。