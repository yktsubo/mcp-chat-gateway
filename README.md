# MCP Chat

Okta でログインし、MCP（Model Context Protocol）サーバーのツールを LLM（Claude または Azure OpenAI）から使うチャットアプリです。Okta Agent Gateway への接続は Cross App Access（XAA）に対応しています。Next.js で作られており、Vercel で動きます。

```
ブラウザ ──(Okta OIDC)──▶ Next.js（Vercel）──▶ Claude / Azure OpenAI
                              ├──(MCP + XAA)───▶ Okta Agent Gateway ──▶ SaaS
                              ├──(MCP + OAuth)─▶ そのほかの MCP サーバー
                              └── Upstash Redis（トークンの保存、回数制限）
```

## 必要なもの

- Okta（Okta for AI Agents と Agent Gateway が使える組織）
- Vercel のアカウント
- Anthropic の API キー、または Azure OpenAI のリソースとデプロイ
- ローカルで動かす場合: Node.js 20.9 以上

## 利用手順

### 1. Okta の設定

1. **Agent Gateway** で仮想 MCP サーバーを作り、その URL（`https://<org>.gateway.okta.com/mcp/servers/<name>`）と認可サーバーを控える
2. AI エージェントに結び付いた OIDC アプリ（Web アプリ）を用意する
   - Grant type: Authorization Code、Refresh Token
   - Sign-in redirect URIs: `https://<ドメイン>/api/auth/callback/okta`、`https://<ドメイン>/api/mcp/callback`
   - Sign-out redirect URIs: `https://<ドメイン>/`
3. XAA を使う場合は、手順 1 の認可サーバーにスコープ（例: `gateway:connect`）と、AI エージェントに JWT Bearer を許可するアクセスポリシーを作り、AI エージェントの **Managed connections** にその認可サーバーを追加する

### 2. Vercel へのデプロイ

1. このリポジトリを Vercel にインポートする
2. **Storage** で Upstash for Redis を作り、プロジェクトにつなぐ（`KV_REST_API_URL` と `KV_REST_API_TOKEN` が自動で設定される）
3. 環境変数を設定して再デプロイする。変数の一覧と説明は `.env.example` にある

| 変数 | 内容 |
|---|---|
| `NEXTAUTH_URL` / `NEXTAUTH_SECRET` | アプリの URL / セッションと、Redis に保存するトークンの暗号鍵（変えると全員が接続し直しになる） |
| `OKTA_ISSUER` / `OKTA_CLIENT_ID` | Okta の issuer / OIDC アプリのクライアント ID |
| `OKTA_CLIENT_SECRET` または `OKTA_AI_AGENT_PRIVATE_KEY` | クライアントシークレット、または AI エージェントの秘密鍵（JWK） |
| `MCP_SERVERS` | MCP サーバーの一覧（下記） |
| `ANTHROPIC_API_KEY` または `AZURE_API_KEY` / `AZURE_RESOURCE_NAME` / `AZURE_OPENAI_DEPLOYMENT` | LLM |

`MCP_SERVERS` の例:

```json
[
  { "name": "gateway", "label": "Okta Agent Gateway", "url": "https://<org>.gateway.okta.com/mcp/servers/<name>",
    "description": "Jira と Confluence", "auth": "xaa", "scope": "gateway:connect" },
  { "name": "notion", "label": "Notion", "url": "https://mcp.notion.com/mcp", "description": "Notion のページとデータベース" }
]
```

| キー | 内容 |
|---|---|
| `name` | ID（英数字と `-`） |
| `label` | 画面に出す名前 |
| `url` | MCP サーバーの URL |
| `description` | 何ができるサーバーか（モデルが接続を求めるかどうかの判断に使う） |
| `auth` | `xaa`（自動で接続）または `oauth`（既定。「接続」ボタンで接続） |
| `scope` | XAA で要求するスコープ |
| `xaa_resource` | `true` にすると、XAA の要求に `resource` を付ける |
| `issuer` | 使う認可サーバー（省略時は Protected Resource Metadata の先頭） |
| `client_id` / `client_secret` | OAuth で使う事前登録したクライアント |

### 3. 使い方

1. アプリの URL を開き、Okta でログインする
2. 右側に MCP サーバーの接続状態が出る（XAA のサーバーは自動で接続される）
3. 「Jira の課題を探して」のように依頼すると、ツールが実行される。OAuth のサーバーが必要なときは「◯◯ に接続」ボタンが出る

### ローカルで動かす

```bash
npm install
cp .env.example .env.local   # 値を入れる
npm run dev                  # http://localhost:3000
```

Redis の接続情報が無いときは、メモリに保存します（再起動で消えます）。

### テスト

```bash
npm test
```

## セキュリティに関する注意

- **LLM は、MCP サーバーのツールをユーザーの確認なしに実行します。** ツールの結果や外部のデータに悪意のある指示が含まれていると（プロンプトインジェクション）、LLM がその指示に従って、書き込みや削除などのツールを呼び出すおそれがあります
- 使わせるツールは必要なものだけにしてください。Okta の **MCP Servers** で公開するツールを絞り（特に作成・更新・削除を行うツール）、認可サーバーのスコープも必要な範囲だけを許可してください
- 接続先の SaaS では、このアプリで使うアカウントの権限を必要な範囲にとどめてください

## 免責事項

- 本ソフトウェアは現状のまま（AS IS）提供され、明示・黙示を問わず、いかなる保証もありません。本ソフトウェアの利用によって生じたいかなる損害についても、作者は責任を負いません。
- 本ソフトウェアは非公式のものであり、Okta, Inc. とは関係がありません。Okta, Inc. による提供、承認、サポートを受けたものではありません。「Okta」は Okta, Inc. の商標です。

## ライセンス

MIT License（`LICENSE`）。

`src/components/ai-elements`（AI Elements、Apache License 2.0）と `src/components/ui`・`src/app/shadcn.css`（shadcn/ui、MIT License）は各プロジェクトのソースコードを取り込んだものです。詳細は `THIRD_PARTY_NOTICES` を参照してください。
