# Tutor-AI（家庭教師AIシステム）環境構築手順書 (deploy.md)

本ドキュメントは、このリポジトリを別のPCにクローンして、システムをイチから構築・動作させるための手順書です。
`.gitignore` で除外されている認証情報や依存ライブラリのセットアップ手順を網羅しています。

---

## 1. 前提条件
構築するPCに、あらかじめ以下のソフトウェアがインストールされている必要があります。

- **Git**
- **Python 3.10 以上**
- **Node.js 18 以上 (および npm)**
  - インストールされていない場合は、[Node.js公式サイト](https://nodejs.org/ja/) から「LTS（推奨版）」をダウンロードしてインストールしてください。インストールすると `npm` というツールも自動的に使えるようになります。
- **Google Cloud Platform (GCP) アカウント**

---

## 2. 構築手順

### STEP 1. リポジトリのクローン
ターミナルを起動し、リポジトリをクローンして作業ディレクトリに移動します。
```bash
git clone <REPOSITORY_URL>
cd 51_tutor-ai
```

---

### STEP 2. バックエンドのセットアップ

#### 1. Python 仮想環境の構築
プロジェクトルートにて、仮想環境 `env` を作成し、アクティベートします。

- **Windows (コマンドプロンプト)**:
  ```cmd
  python -m venv env
  call env\Scripts\activate
  ```
- **Windows (PowerShell)**:
  ```powershell
  python -m venv env
  .\env\Scripts\Activate.ps1
  ```
- **Mac / Linux**:
  ```bash
  python3 -m venv env
  source env/bin/activate
  ```

#### 2. 依存パッケージのインストール
仮想環境がアクティベートされた状態で、以下のコマンドを実行して必要なライブラリをインストールします。
```bash
pip install fastapi uvicorn python-multipart sqlalchemy google-cloud-speech google-cloud-texttospeech google-genai pyyaml
```

*※ 各ライブラリの役割:*
- `fastapi`, `uvicorn`, `python-multipart`: APIサーバーとファイルアップロード処理用
- `sqlalchemy`: SQLiteデータベースの操作用
- `google-genai`: Vertex AIによる Gemini モデルの利用
- `google-cloud-speech`: ユーザーの音声認識 (STT) 用
- `google-cloud-texttospeech`: AI回答の音声合成 (TTS) 用
- `pyyaml`: 設定プロンプト (`prompts.yaml`) の読み込み用

---

### STEP 3. GCP 認証情報 (api.json) の配置
本システムでは、Google Cloudの生成AI (Vertex AI)、音声認識 (STT)、音声合成 (TTS) を使用します。これらを実行するためのサービスアカウントキーを配置する必要があります。

1. **GCPコンソールでの作業**:
   - GCPコンソールの「IAMと管理」 > 「サービスアカウント」から、新規サービスアカウントを作成します。
   - サービスアカウントに以下のロール（権限）を付与します：
     - **Vertex AI ユーザー** (`Vertex AI User`)
     - **Cloud Speech ユーザー** (`Cloud Speech User`) または **Cloud Speech 管理者**
     - **Cloud Text-to-Speech ユーザー** (`Cloud Text-to-Speech User`) または **Cloud Text-to-Speech 管理者**
   - 作成したサービスアカウントの「キー（鍵）」タブから、「鍵を追加」 > 「新しい鍵を作成」を選択し、**JSON形式**で秘密鍵ファイルをダウンロードします。

2. **ファイルの配置**:
   - リポジトリの `backend` ディレクトリ内に `env` フォルダを作成します。
     ```bash
     mkdir backend/env
     ```
   - ダウンロードしたJSONファイルの名前を **`api.json`** に変更し、`backend/env/` の直下に配置します。
   - **配置場所**: `backend/env/api.json`
   - *※ `api.json` は `.gitignore` に登録されているため、Gitにコミットされる心配はありません。*

---

### STEP 4. フロントエンドのセットアップ

フロントエンド（画面部分）を動かすための準備をします。ここでは Node.js に付属しているパッケージ管理ツール `npm` を使用します。

1. **フロントエンドのフォルダに移動します**
   ターミナルで以下のコマンドを実行します。（バックエンドの設定から続けて行う場合は、一度 `cd ..` でプロジェクト直下に戻ってから実行してください）
   ```bash
   cd frontend
   ```

2. **Node.jsのインストール状況の確認（任意）**
   念のため、正しくインストールされているか確認したい場合は以下のコマンドを打ちます。バージョン番号が表示されればOKです。
   ```bash
   node -v
   npm -v
   ```

3. **依存パッケージのインストール**
   以下のコマンドを実行します。
   ```bash
   npm install
   ```
   **💡 【超初心者向け解説：このコマンドで何が起こるの？】**
   先ほどの `package.json` の説明でもあったように、このコマンドを打つと、システムの設計図を読み取り、React や Vite といった画面を作るのに必要なプログラム（ライブラリ）の部品を、インターネットから自動的にダウンロードしてきてくれます。
   ダウンロードされた大量のファイルは、新しく作られる `node_modules` というフォルダの中に自動で整理して保存されます。環境によってはダウンロードに数分かかることがあります。

---

## 3. アプリケーションの起動方法

### 起動方法A: Windowsで一括起動する (推奨)
Windows環境であれば、プロジェクトのルートディレクトリにある `start.bat` をダブルクリックするか、ターミナルで実行するだけで、バックエンドとフロントエンドが別ウィンドウで一括起動します。
```cmd
# プロジェクトルートにて実行
start.bat
```

### 起動方法B: 手動で個別に起動する
他OS環境や手動で起動する場合は、2つのターミナルを開いて以下のコマンドを実行します。

#### 1. バックエンドの起動
```bash
# ターミナル1 (仮想環境 env をアクティベートした状態で)
cd backend
uvicorn app.main:app --reload --port 8080
```
- バックエンドは `http://localhost:8080` で待機します。

#### 2. フロントエンドの起動
```bash
# ターミナル2
cd frontend
npm run dev
```
- フロントエンドは `http://localhost:5173` で起動します。ターミナルに表示されるURLにブラウザでアクセスしてください。

---

## 4. 動作確認
1. ブラウザでフロントエンドにアクセスします。
2. 画面の指示に従い、マイクの使用許可を付与します。
3. 音声またはカメラ撮影画像を用いて質問を送信し、AIの回答テキストおよび合成音声が正しく流れるか確認します。
