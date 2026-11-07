# Metro Master Sync

[捷運規劃大師](https://metromaster.huangyouci.com/)（metromaster.huangyouci.com）的跨裝置存檔同步工具，跑在 Cloudflare Workers + R2 上。

- 正式站：<https://metromastersync.yijiun.com>
- 手機上玩到一半，可以到電腦上接著玩；想試新玩法時，先把現在的進度存到雲端，就不怕開新遊戲把舊紀錄蓋掉。
- 登入只要一組密碼，不用帳號。
- 支援 iPhone / Android / 桌機，Safari、Chrome、Firefox、Edge 都能用。

任何人都可以用自己的 Cloudflare 帳號和網域部署一份，步驟見[部署到 Cloudflare](#部署到-cloudflare)。

---

## 目錄

1. [運作原理](#運作原理)
2. [兩種使用方式](#兩種使用方式)
3. [管理介面功能](#管理介面功能)
4. [自動儲存](#自動儲存)
5. [部署到 Cloudflare](#部署到-cloudflare)
6. [設定參數一覽](#設定參數一覽)
7. [程式內的常數與數值](#程式內的常數與數值)
8. [API 文件](#api-文件)
9. [資料格式](#資料格式)
10. [瀏覽器 localStorage 使用的 key](#瀏覽器-localstorage-使用的-key)
11. [安全性](#安全性)
12. [費用與用量](#費用與用量)
13. [本機開發](#本機開發)
14. [疑難排解](#疑難排解)
15. [已知限制](#已知限制)
16. [專案結構](#專案結構)

---

## 運作原理

遊戲把進度存在**它自己網域**的 `localStorage`，key 都以 `transit-planner:` 開頭（大多是 `transit-planner:v4:*`）。瀏覽器的同源政策不允許其他網站讀取這些資料，所以這個工具提供兩種方式把資料拿出來：

| | A. 我的網域版 `/play/` | B. 原網站 + userscript 或書籤 |
|---|---|---|
| 遊戲網址 | `https://<你的網域>/play/` | `https://metromaster.huangyouci.com/` |
| 怎麼載入同步程式 | Worker 轉接原遊戲時直接把程式插入頁面 | userscript 每次開遊戲自動載入；或在遊戲頁點一下書籤 |
| 要設定什麼 | 不用 | 每台裝置、每個瀏覽器裝一次 userscript 或加一次書籤 |
| 自動儲存 | 有（預設開啟） | 有（預設開啟）；userscript 開遊戲就啟動，書籤要每次點一下才啟動 |
| 遊戲內 Google／Apple 登入（排行榜等） | 不能用（遊戲的 Firebase 只允許原網站） | 可以 |
| 管理介面一鍵載入 | 有 | 要先設成「待匯入」，再到遊戲頁打開 🚇 面板 |
| 跳過推廣廣告倒數 | 有 | 沒有 |
| 進度存放位置 | 你的網域的 localStorage | 原網站的 localStorage |

兩種方式的進度**互不相通**（存在不同網域），但都可以存到同一份雲端，所以能透過雲端互相轉移。

雲端存檔放在 Cloudflare R2。R2 的讀取和列表都是強一致的，A 裝置存完，B 裝置馬上就看得到。

### 架構

```
瀏覽器 ──► Cloudflare Worker（src/worker.js）
            ├─ /api/*   → 存檔 API（R2：SAVES）
            ├─ /play/*  → 轉接 GAME_ORIGIN，插入 core.js + inject.js
            ├─ /mms.user.js → 產生原網站用的 userscript（載入 inject.js?mode=auto）
            └─ 其他     → 靜態檔案（public/：管理介面、core.js、inject.js）
```

---

## 兩種使用方式

### A. 我的網域版（推薦，不用書籤）

1. 打開 `https://<你的網域>/`，輸入密碼登入。
2. 點「我的網域版遊戲 → 開始玩」，或直接開 `https://<你的網域>/play/`。未登入時會先導到登入頁，登入後自動回到遊戲。
3. 遊戲左上角（距離頂端安全區域 64px）會出現 🚇 按鈕，點開是同步面板：
   - **存檔名稱 + 儲存目前進度**：把目前進度存成一筆新的雲端存檔（`source=manual`）。名稱欄位預設帶入目前進度來源存檔的名稱。
   - **自動儲存**勾選框：說明見[自動儲存](#自動儲存)。旁邊顯示「上次 HH:MM」或「失敗：原因」。
   - **存檔列表**：最多顯示 50 筆，依最後更新時間排序，按「載入」就能覆蓋目前進度。
   - **固定顯示計算監測面板**、**排行榜檢查**：說明見[計算監測與排行榜檢查](#計算監測與排行榜檢查)。
4. 手機可以用「加入主畫面」把 `/play/` 當成 App 開。

`/play/` 另外做了這些處理：

- **跳過自家推廣廣告的倒數**：Worker 在頁面插入 `<style>.promo-sheet{display:none!important}</style>`。遊戲本身會在廣告出現 300ms 後檢查廣告是否被隱藏，被隱藏就直接給獎勵並關閉。所以「看廣告解鎖」會立即完成，回首頁的插頁也不會擋住畫面。這些廣告是原作者推廣自己其他 App 的 house ad。付費購買（ALL ACCESS）的狀態**沒有**被修改。
- **自動略過「下載 App」對話框**：手機開啟時遊戲會跳出下載 App 的對話框，程式會自動點「在網頁玩」（`.get-app .play-web`）。
- **多分頁同步**：從管理介面或其他分頁載入存檔時，會透過 `BroadcastChannel('mms')` 通知所有開著的遊戲分頁先暫停寫入、再重新整理。背景分頁可能收不到訊息，所以回到前景時（`visibilitychange`）和收到 `storage` 事件時，也會檢查 `mms:import-at` 標記有沒有變。
- 遊戲頁的回應會加上 `Cache-Control: no-store` 和 `X-Robots-Tag: noindex, nofollow`，並移除上游的 `set-cookie`、`content-security-policy`、`report-to`、`nel`、`alt-svc` 標頭。
- 只轉接 `GET` / `HEAD`，其他方法回 `405`。

### B. 原網站 + userscript 或書籤

#### userscript（推薦）

裝好之後，每次打開原網站的遊戲，左上角就會自動出現 🚇 按鈕，自動儲存也會跟著啟動，不用每次點書籤。用法和 `/play/` 相同，但保有原網站的帳號功能（登入、排行榜、帳號名稱、遊戲內建雲端同步）。

1. 先安裝 userscript 管理器：
   - **電腦 Chrome／Edge／Firefox**：Tampermonkey 或 Violentmonkey。Chrome／Edge 要在擴充功能的設定裡開啟「允許使用者指令碼」（或開發人員模式）。
   - **Mac／iPhone／iPad Safari**：App Store 的「Userscripts」（免費）。到 Safari 設定 → 延伸功能啟用它，並允許它在 `metromaster.huangyouci.com` 執行。
   - **Android**：Firefox 加上 Violentmonkey（Android 版 Chrome 不支援擴充功能）。
2. 打開 `https://<你的網域>/mms.user.js`（管理介面「原網站同步」區塊有「安裝 userscript」按鈕），管理器會跳出安裝畫面。Safari 的 Userscripts 要點網址列的 Userscripts 圖示，再按安裝。
3. 在遊戲的設定裡用 Google 或 Apple 登入帳號（只需一次），然後重新整理遊戲。

登入方式和遊戲帳號版書籤相同：讀取遊戲的登入狀態，交給 Worker 驗證後換發本站 token，存在原網站的 `localStorage['mms:token']`。所以要先完成[設定遊戲帳號登入](#7-設定遊戲帳號登入選用)。還沒連上時（遊戲沒登入，或帳號不在 `ALLOWED_ACCOUNTS`）🚇 按鈕會呈半透明，滑鼠移上去會顯示原因，點按鈕會再試一次並跳出錯誤訊息。token 失效時會自動清掉，下次再用遊戲帳號重新換發。

userscript 本身只有十幾行：它在頁面插入 `<script src="https://<你的網域>/inject.js?mode=auto">`，同步程式每次都從你的網域載入最新版，所以更新功能不用重裝 userscript。腳本裡不含任何登入資訊，網址也是 Worker 依照目前網域產生的。

同時裝了 userscript 又點書籤也沒關係，書籤只會開關面板，不會重複啟動自動儲存。

#### 書籤

不能裝 userscript 的瀏覽器用這個。書籤有兩種：

- **遊戲帳號版（預設）**：書籤不含登入資訊。點書籤時，它會讀取你在遊戲裡登入的帳號（Google／Apple），交給 Worker 驗證，換到本站的 token。所以書籤可以放心放在任何裝置。前提是先完成[設定遊戲帳號登入](#7-設定遊戲帳號登入選用)，並且在遊戲裡登入帳號。管理介面的登入頁就有這個書籤，還沒用密碼登入也能取得。
- **內含登入資訊版**：在「原網站同步」區塊勾選「書籤內含登入資訊」就會產生。書籤裡直接帶著一年有效的 token，不需要遊戲帳號。

加入書籤的方法：

1. 在管理介面登入後，到「原網站同步」區塊（遊戲帳號版也可以在登入頁取得）：
   - **桌機**：把「🚇 存檔同步」按鈕拖到書籤列。
   - **iPhone / iPad Safari**：先把任意網頁加入書籤，按「複製書籤網址」，再到書籤管理把該書籤的網址改成剛剛複製的內容。
   - **Android Chrome**：同上，編輯書籤網址後，在網址列輸入書籤名稱，從建議清單點它執行。
2. 到 `metromaster.huangyouci.com` 的遊戲頁面點書籤，就會開出同步面板（再點一次會關閉）。
3. 面板功能和 `/play/` 相同。第一次點書籤後，這個分頁就會開始自動儲存，關掉面板也會繼續；重新整理或重新開啟遊戲後要再點一次書籤。
4. 用遊戲帳號版書籤時，按面板右上角的「管理介面」，就會帶著 token 開啟管理介面並自動登入。token 放在網址 `#` 後面，不會送到伺服器，管理頁讀到後會立刻從網址移除。

內含登入資訊版的書籤長這樣，裡面帶有一年有效的登入 token，所以**不要分享給別人**（遊戲帳號版只是少了 `token` 欄位）：

```js
javascript:(function(){window.__MMS={"api":"https://<你的網域>","token":"<exp>.<sig>"};var s=document.createElement('script');s.src='https://<你的網域>/inject.js?t='+Date.now();document.body.appendChild(s);})();
```

token 直接帶在書籤裡，不靠第三方 Cookie，所以 Safari 的追蹤防護不會擋。原遊戲網站目前沒有 CSP，可以載入外部 script。如果原作者之後加上 CSP，書籤方式會失效，但 `/play/` 不受影響。

### 載入存檔的流程（兩種方式共用）

1. 跳出確認視窗。
2. 從雲端下載存檔。
3. 讓遊戲先把記憶體中的最新進度寫進 localStorage（`flushGame()`：模擬一次 `visibilitychange` 切到背景）。
4. 如果目前有進度，先存一份「匯入前自動備份」（`source=auto-backup`）到雲端。
5. 如果這筆是「待匯入」，清除待匯入標記。
6. 暫停遊戲寫入：攔截 `Storage.prototype.setItem/removeItem`，擋掉所有 `transit-planner:` 開頭的寫入。這樣遊戲在重新整理前觸發的存檔，不會把舊進度寫回去。
7. 刪除所有可同步的 key，寫入存檔的 key；寫入失敗會還原成原本的內容。
8. 重新整理頁面。

### 只匯入單一計劃

整份載入會把這個瀏覽器的所有計劃、所有城市都換成存檔的內容。如果只想搬其中一份（例如把 `/play/` 玩好的一份搬到原網站上榜），用「選計劃」：

| 位置 | 按鈕 | 寫入到 |
|---|---|---|
| 🚇 面板的每筆存檔、待匯入列 | 「選計劃」 | 目前這個網域（原網站或 `/play/`） |
| 管理介面的每筆存檔 | 「單一計劃到我的網域版」 | 我的網域版 `/play/`，完成後跳到 `/play/` |

選擇方式：

1. **來源**：列出存檔裡所有計劃，格式是「城市・計劃 N：車站 / 路線 / 日運量」。也會列出挑戰（`qsave.<slug>`），以及還沒升級的舊版計劃（`save~N`，顯示「舊版計劃 N」）。舊版升級後留下的指標不會列出。
2. **覆蓋**：列出這個瀏覽器**同一個城市**的計劃，預設選目前的計劃。
   - 計劃：選一份要被覆蓋的本機計劃。
   - 該城市在這個瀏覽器還沒有任何計劃：只能「建立成第 1 份」。
   - 挑戰：固定覆蓋本機同一個挑戰。

**不會新增計劃**：只會覆蓋你選的那一份，計劃數量不變（遊戲的計劃數有上限，計劃 4、5 需要付費解鎖，所以不會自動多開）。唯一例外是城市本來沒有任何計劃時建立第 1 份。

寫入的內容：

- 計劃：把來源的存檔寫到 `psave.<目標 id>`、摘要寫到 `psummary.<目標 id>`，刪除 `pstats.<目標 id>`（遊戲會重算）。`planlist` 的 id 和順序不變，只把 `current` 改成目標，讓重新載入後直接開這份。來源是舊版 `save~N` 時一樣寫成第 5 版鍵名。
- 挑戰：寫入 `qsave.<slug>`、`qsummary.<slug>`，刪除 `qstats.<slug>`。
- 把上次的城市（`transit-planner:v4:city`）設成來源的城市。
- 其他計劃、其他城市、解鎖紀錄等都不動。

流程和整份載入相同：先讓遊戲把最新進度寫進 localStorage、存一份「匯入前自動備份」、暫停遊戲寫入並通知其他分頁，寫入後重新載入。寫入失敗會還原改過的 key。匯入後清除 `mms:autosave-hash`，所以自動儲存下次一定會上傳新的狀態。

### 計算監測與排行榜檢查

🚇 面板裡的兩個診斷工具，`/play/` 和原網站（userscript、書籤）都能用。只讀資料，不會修改存檔。

**固定顯示計算監測面板**（勾選框，設定存在 `localStorage['mms:monitor-on']`，每個網域分開，預設關閉）

勾選後，🚇 按鈕下方會常駐一個小面板，重新整理後也會自動顯示：

| 欄位 | 意思 |
|---|---|
| 工作比例 | 遊戲分給背景計算的時間：操作中 15%、2–30 秒內操作過 30%、閒置 50%、在首頁或分頁在背景 100%；省電模式再減半 |
| 正式統計 | 「計算中」跑到第幾回合（上限 600）、已算多久、每回合多久。超過 60 秒且超過 6 回合的時間沒有進度時顯示「⚠️ 可能卡住」 |
| ✔ 算完 | 最近 3 次算完的回合數、實際運算時間、經過時間 |
| 模擬回應 | 遊戲送出一次模擬到收到結果的時間（需求圖層、乘客等跟著它更新） |
| 主執行緒延遲 | 畫面本身被卡住的時間 |

原理：遊戲把模擬（`stepWorker`）和正式統計（透過 `officialPort` 跑在同一個 Worker）放在背景執行緒。程式包裝 `Worker.prototype.postMessage`，在 `inject.js` 一啟動就裝上，所以勾選前的進度也記得到；遊戲已經建立的 Worker 也能攔截到。

**加速計算**：監測面板上的按鈕。把遊戲送給背景執行緒的工作比例（`budget.duty`）固定成 1，正式統計會快一些，但仍比把分頁切到背景慢（背景時遊戲會暫停模擬）。重新整理頁面就恢復遊戲預設。

實測（無頭 Chromium、795 站 48 線的計劃）：

| 狀態 | 正式統計算完 |
|---|---|
| 前景、閒置（50%） | 150 秒只算到第 24 回合，約 6–10 秒一回合 |
| 前景＋加速計算 | 約 166–262 秒 |
| 分頁在背景（100%，模擬暫停） | 約 80 秒（33 回合） |

大路網的模擬本身也很重：795 站一次模擬約 4–5 秒，3 站只要 17 ms，正式統計算完後也一樣。所以大計劃改站後，需求圖層要等幾秒才更新是遊戲本身的運算量，不是存檔問題。

**排行榜檢查**（按鈕，展開三張表，可按「重新整理」）：

| 表 | 內容 |
|---|---|
| ① 各計劃可上的榜 | 每份計劃與挑戰的站數、線數、日運量、收支比、正式統計是否算完（`official` 且 `model` 是目前版本），以及可上的榜 |
| ② 遊戲雲端同步紀錄 | `transit-planner:v4:account` 的 `units`：每份計劃在遊戲雲端的版本與站數。沒有登入遊戲帳號時沒有這份紀錄，也不會上榜 |
| ③ 這台裝置送上榜的成績 | `transit-planner-account:board`（遊戲自己的紀錄，不會被同步）：每個榜送出的來源計劃、站數、線數、分數、時間，以及被拒絕、等待重送的榜 |

遊戲的上榜規則（取自遊戲程式）：

- 排行榜分「日運量」和「收支平衡」兩個榜；收支比 ≥ 100% 才能上「收支平衡」。站數 2–1000、線數 1–60。
- 每個榜只保留每位玩家最好的一份，日運量比現有成績高才會送出。
- 正式統計要算完，且計劃已同步到遊戲雲端（本機內容和雲端一致）才會送。
- 不是即時的：遊戲在帳號同步時才送出（改完約 10 分鐘，或回到首頁時），同一個榜每小時最多送一次。

---

## 管理介面功能

網址 `https://<你的網域>/`。

| 區塊 | 功能 |
|---|---|
| 登入 | 輸入密碼。登入後 token 存在 `localStorage['mms:token']`，同時設定 `/play/` 用的 HttpOnly Cookie。網址帶 `?next=play` 時，登入後自動跳到 `/play/`。 |
| 我的網域版遊戲 | 「開始玩」→ `/play/`。「儲存目前進度」→ 把 `/play/` 的進度存到雲端，名稱預設為目前存檔名。旁邊顯示「本機有進度：名稱（KB）」。 |
| 原網站同步 | 「安裝 userscript」按鈕與各平台安裝說明；書籤（拖曳或複製書籤網址，可選是否內含登入資訊），附各平台設定說明。 |
| 待匯入 | 有待匯入存檔時顯示，可開啟遊戲或取消。 |
| 雲端存檔 | 分成「釘選」「最近存檔」「歷史存檔」三區，依最後更新時間排序，最新的一筆標「最新」。 |

每筆存檔的按鈕：

| 按鈕 | 作用 |
|---|---|
| 載入到我的網域版 | 備份目前進度 → 寫入 → 通知其他分頁重新整理 → 跳到 `/play/` |
| 單一計劃到我的網域版 | 展開選計劃表單，只把一份計劃覆蓋到我的網域版同城市的一份計劃。見[只匯入單一計劃](#只匯入單一計劃)。 |
| 匯入到原網站 | 設成「待匯入」（`PUT /api/pending`）並開啟原遊戲網站；在那裡點書籤就會出現一鍵載入。為了避免 Safari 擋掉 `await` 之後的 `window.open`，會先同步開好視窗再導向。 |
| 下載 | 下載 `{version:1, keys:{...}}` JSON，檔名 `metromaster-<名稱>-<YYYY-MM-DD-HH-MM>.json` |
| 解鎖全部 | 把這筆存檔補成「全解」（`owned:true`，等同 `unlock_all`），一併解鎖 計劃 4/5、自訂顏色、區間 3。只改 `transit-planner:v4:unlock` 一個 key，其餘內容保留；已全解的不會重複改。見下方[解鎖全部功能](#解鎖全部功能可選)。 |
| 改名 | `PATCH` 名稱 |
| 釘選 / 取消釘選 | 釘選的存檔固定顯示在最上方 |
| 歷史版本 | 只有自動儲存有。展開該筆的歷史版本列表，可以還原成新存檔或下載。見[歷史版本](#歷史版本)。 |
| 刪除 | 永久刪除，無法復原；自動儲存的歷史版本也會一起刪除 |

其他：

- **上傳備份檔**：可以上傳本工具下載的 JSON，或是外層包了 `{data:{keys}}` 的格式。存檔名稱用檔名（去掉 `.json`），`source=upload`。
- **顯示匯入前備份**：預設隱藏 `auto-backup` 存檔（釘選的除外），勾選後才會顯示。
- 來源標籤：`manual` 手動儲存、`auto-save` 自動儲存、`auto-backup` 匯入前備份、`upload` 檔案上傳、`restore` 從歷史版本還原。
- 更新時間比建立時間晚 1 秒以上時，顯示「更新於 …」。
- 每筆存檔會顯示摘要：城市・計劃 N（或挑戰）：車站數 / 路線數 / 日運量，最多 12 份，依車站數排序。計劃編號是它在遊戲計劃清單（`planlist`）裡的順序；不在清單裡的顯示「計劃 ?」。摘要是存檔寫入時算好的，這次改版前建立的存檔要等下次覆寫（例如自動儲存）才會更新。

### 解鎖全部功能（可選）

預設**關閉**。把存檔補成「全解」——遊戲商店紀錄的 `owned: true`（等同 `unlock_all` 購買），會一併解鎖：

- **計劃 4、計劃 5**：方案數上限放开。
- **自訂顏色**：可使用自訂線色。
- **區間 3**：班次 / 服務上限放开。

> 「自訂我的帳號名稱」是遊戲帳號的伺服器端功能，存檔改不到，所以這個功能**不含改名**；改名請回到遊戲裡用 Google/Apple 帳號自己改。

兩處都能操作：

| 位置 | 開關 | 作用 |
|---|---|---|
| 🚇 遊戲內面板 / 管理介面 | 勾「解鎖全部功能」 | 之後的「儲存目前進度」和**自動儲存**都會自動補上全解；勾上時也會**立刻**把本機進度補上，重新載入遊戲畫面後生效 |
| 管理介面 | 每筆存檔的「解鎖全部」按鈕 | 只把**該筆雲端存檔**補成全解（`GET` 下來 → 補 `owned` → `PUT` 回去，保留建立時間、來源、釘選） |

實作細節：

- 遊戲的商店紀錄存在 `transit-planner:v4:unlock`（一個 JSON 字串，含 `owned`、`unlocked` 等欄位）。遊戲把 `owned: true` 視為 ALL ACCESS，所以補上它就等於解鎖上述項目。
- 補寫時**保留原本的欄位**（已解項目、`sessions`、`day` 等），只有 `owned` 不是 `true` 時才翻過去；紀錄缺損或不存在時才改用遊戲的建檔預設。所以是**非破壞性**也是**冪等**的：再按一次不會拔除已補的全解，也沒有開關會移除既有全解。
- 開關記在本機 `localStorage['mms:unlock-all']`（`'1'` = 開啟，其他 / 沒有 = 關閉；每台裝置、每個網域分開），預設關閉。
- 這是**純前端**改寫，沒碰伺服器端。`/play/` 我方網域版把這份 unlock 只讀進遊戲記憶體，之後的寫入都會保留 `owned`，補上後不會被清掉。是否會被原作者的伺服器端驗證影響，視遊戲本身的實作為準。

---

## 自動儲存

`/play/` 和裝了 userscript 的原網站，開遊戲就啟動；只用書籤的原網站，在點書籤後啟動，直到分頁關閉或重新整理。兩邊的開關、自動儲存的存檔各自分開（存在不同網域）。

| 項目 | 值 |
|---|---|
| 預設 | 開啟 |
| 開關位置 | 🚇 面板的「自動儲存」勾選框 |
| 開關儲存位置 | `localStorage['mms:autosave-on']`（`'0'` = 關閉，其他值或沒有設定 = 開啟），每台裝置、每個瀏覽器、每個網域分開 |
| 觸發時機 | 頁面在前景時每 **30 秒**一次；切到背景（`visibilitychange` → hidden，等遊戲自己寫完再讀）；關閉頁面（`pagehide`） |
| 跳過條件 | 已關閉、正在匯入（寫入被凍結）、沒有登入 token、雲端有未處理的衝突、沒有遊戲進度、進度雜湊和上次相同 |
| 頁面關閉時 | 請求內容小於 **60,000** 字元時使用 `fetch(..., {keepalive:true})`，確保頁面關掉後仍會送出（瀏覽器的 keepalive 上限是 64KB） |
| 雜湊 | FNV-1a 32-bit，先把 key 排序，所以和 key 順序無關；格式 `<長度>:<base36>` |

**一直更新同一筆存檔**，不會每次新增一筆：

- 第一次自動儲存時新增一筆 `source=auto-save` 的存檔，id 記在 `mms:autosave-id`，之後都用 `PUT /api/snapshots/:id` 覆寫。
- 那筆被刪掉時（API 回 `404`），會自動再新增一筆。
- **載入自動儲存的存檔**：接續更新那一筆。所以手機玩到一半，到電腦載入同一筆繼續玩，兩邊更新的都是同一筆。
- **載入手動存檔或其他存檔**：清除 `mms:autosave-id`。之後有變動時另外新增一筆同名的自動儲存，原本的存檔保持不變。
- 剛載入時會記下存檔的雜湊，所以只是載入、沒有變動，不會馬上多出一筆自動儲存。
- 自動儲存的名稱跟著 `mms:current` 的名稱走；裝置欄位每次更新成目前的裝置。

### 防止兩台裝置互相覆蓋

每筆存檔有一個內容版本號 `rev`：新建是 1，每次覆寫內容 +1；改名、釘選不會改變它。

- 每台裝置記住自己最後同步到的版本（`localStorage['mms:autosave-rev']`）。載入自動儲存的存檔、自動儲存上傳成功時更新。
- 自動儲存上傳時帶上 `baseRev`。雲端版本和它不同，代表另一台裝置已經更新過，Worker 回 `409`，**不覆寫**。
- Worker 寫入時用 R2 的條件寫入（`onlyIf: { etagMatches }`），讀取到寫入之間被其他請求改過就重讀再判斷。所以就算兩台在同一瞬間上傳，也只有一台成功。改名、釘選也改成條件寫入，不會把同時上傳的新內容蓋回舊的。
- 衝突時：
  - 自動儲存暫停，衝突記在 `localStorage['mms:autosave-conflict']`，重新整理後仍然有效。
  - 🚇 按鈕變成 ⚠️ 並加上橘色外框；面板的自動儲存顯示「已暫停（雲端有衝突）」。
  - 面板上方顯示是哪台裝置、什麼時間更新的，並提供三個選項：

| 選項 | 作用 |
|---|---|
| 載入雲端版本 | 走一般的載入流程：先把這台的進度存成「匯入前自動備份」，再載入雲端最新版，之後接續更新同一筆 |
| 另存成新存檔 | 把這台的進度存成一筆新的自動儲存（名稱加上「（裝置名稱）」），之後改更新這一筆；原本那筆不動 |
| 仍然覆蓋 | 以剛才看到的雲端版本為基準覆寫（確認後執行）。被蓋掉的版本仍可從[歷史版本](#歷史版本)找回；這段時間又被更新的話會再次提醒 |

- 只有「本機有變動、要上傳」時才會發現衝突。兩台都只是開著沒動，不會提醒。
- 這個功能之前就開始的自動儲存，本機還沒有記錄版本，第一次上傳不帶 `baseRev`、照舊覆寫並記下版本，之後才開始檢查。舊存檔在 R2 上沒有 `rev`，視為 0。
- 管理介面的「解鎖全部」寫回時也帶 `baseRev`，避免蓋掉同時進來的自動儲存。
- 還沒重新整理、仍在跑舊版程式的遊戲分頁不帶 `baseRev`，照舊覆寫。更新後請重新整理各裝置的遊戲頁。

### 歷史版本

自動儲存每次覆寫雲端存檔之前，Worker 會先把被覆寫的舊內容存成一個歷史版本，所以就算存到一份玩壞的進度、匯入錯了，或被遊戲內建的雲端同步蓋掉，也能找回之前的狀態。

| 項目 | 值 |
|---|---|
| 哪些存檔有 | 只有 `source=auto-save`（自動儲存）。手動存檔不會被覆寫，改名、釘選也不會產生版本 |
| 最小間隔 | 被覆寫的舊內容，距離上一個版本不到 **15 分鐘**時不另存（避免每 30 秒存一份） |
| 保留規則 | 2 小時內全部保留；2–24 小時每小時一份；1–30 天每天一份；30–180 天每週一份；超過 180 天刪除。每個區間保留最新的那份 |
| 數量上限 | 每筆自動儲存約 80 份（實測模擬 200 天、每 5 分鐘自動儲存一次，保留 82 份） |
| 清理時機 | 每次新增版本時順便清掉超出規則的版本；刪除存檔時一併刪除它的所有版本 |

在管理介面的自動儲存項目按「歷史版本」，會在下方列出所有版本（時間、裝置、大小、前 3 份計劃的摘要）：

- **還原成新存檔**：把那個版本複製成一筆新的存檔（來源標籤「從歷史版本還原」，名稱是「原名稱（時間 版本）」），原本的自動儲存和其他版本都不變。之後就能像一般存檔一樣載入到我的網域版、匯入到原網站或下載。
- **下載**：下載那個版本的 JSON，格式和一般存檔的下載相同。

---

## 部署到 Cloudflare

### 事前準備

| 需要 | 說明 |
|---|---|
| Cloudflare 帳號 | 免費方案就夠用 |
| 一個網域 | 必須已經加到同一個 Cloudflare 帳號，並使用 Cloudflare 的 DNS（nameserver 指向 Cloudflare）。沒有網域也可以用 `*.workers.dev`，見[不用自己的網域](#不用自己的網域workersdev)。 |
| R2 | 第一次使用要在 Dashboard → R2 啟用（需要綁定付款方式，但免費額度內不收費） |
| Node.js | **22 以上**（wrangler 4 的需求） |
| Git / GitHub | 只有要用 GitHub Actions 自動部署時才需要 |

### 1. 取得程式碼並安裝

```sh
git clone git@github.com:yijiunchin/metro-master-sync.git
cd metro-master-sync
npm install
```

### 2. 修改 `wrangler.jsonc`

這是唯一**一定要改**的檔案。程式碼裡的網址都是從請求的 origin 算出來的，換網域不用改程式。

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "metromastersync",                         // Worker 名稱，可自訂
  "account_id": "<你的 Cloudflare Account ID>",       // ← 改成你的，或整行刪掉
  "main": "src/worker.js",
  "compatibility_date": "2026-10-01",
  "workers_dev": false,
  "routes": [{ "pattern": "sync.example.com", "custom_domain": true }], // ← 改成你的子網域
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*"]
  },
  "r2_buckets": [{ "binding": "SAVES", "bucket_name": "metromastersync-saves" }], // bucket 名稱可自訂
  "vars": { "GAME_ORIGIN": "https://metromaster.huangyouci.com" }
}
```

要改的地方：

| 欄位 | 改成 | 備註 |
|---|---|---|
| `account_id` | 你的 Account ID | Dashboard 右側欄「Account ID」可以複製，或執行 `npx wrangler whoami`。刪掉這一行的話，wrangler 會用登入帳號或環境變數 `CLOUDFLARE_ACCOUNT_ID`。帳號有多個時，請務必填寫，避免部署到錯的帳號。 |
| `routes[0].pattern` | 你的（子）網域，例如 `sync.example.com` | `custom_domain: true` 會自動建立 DNS 記錄和 SSL 憑證，不用自己加 DNS。這個主機名稱不能已經有其他 DNS 記錄。 |
| `name` | 任意 | 選填。改了會變成另一個 Worker。 |
| `r2_buckets[0].bucket_name` | 任意 | 選填。要和下一步建立的 bucket 名稱一樣。`binding` 必須維持 `SAVES`。 |

不要改的地方：`main`、`assets.binding`（`ASSETS`）、`assets.run_worker_first`、`r2_buckets[0].binding`（`SAVES`）、`vars.GAME_ORIGIN`（除非原遊戲搬家）。

### 3. 登入 Cloudflare

```sh
npx wrangler login     # 會開瀏覽器授權，請用「擁有該網域」的帳號
npx wrangler whoami    # 確認帳號與 Account ID
```

### 4. 建立 R2 bucket

```sh
npx wrangler r2 bucket create metromastersync-saves
```

bucket 名稱要和 `wrangler.jsonc` 一致。

### 5. 部署

```sh
npm run deploy         # 等同 npx wrangler deploy
```

### 6. 設定登入密碼

```sh
npx wrangler secret put APP_PASSWORD
# 提示輸入時貼上密碼。建議用隨機產生的長密碼，例如：
# openssl rand -base64 12
```

也可以到 Dashboard → Workers & Pages → `metromastersync` → Settings → Variables and Secrets，新增一個 **Secret** 類型的 `APP_PASSWORD`。

secret 不會被之後的 `wrangler deploy` 覆蓋。還沒設定時，登入會回 `500 尚未設定 APP_PASSWORD`。

### 7. 設定遊戲帳號登入（選用）

遊戲網頁版用 Firebase Auth 登入（專案 `app-metromaster`，已寫在 `wrangler.jsonc` 的 `FIREBASE_PROJECT_ID`）。要讓遊戲帳號能登入本站，把允許的帳號設成 secret：

```sh
npx wrangler secret put ALLOWED_ACCOUNTS
# 輸入 email 或 Firebase uid，多個用逗號分隔，例如：me@gmail.com
```

用 email 比對時，只接受 Google 已驗證的 email。Apple 登入若選了「隱藏我的電子郵件」，email 會是轉寄地址，這時改用 uid 比較穩定。不知道 uid 的話，先用遊戲帳號版書籤點一次，錯誤訊息會顯示這個帳號的 email 和 uid。

這個 secret 放在 Cloudflare，不會進 Git，所以公開 repo 也不會洩漏你的 email。沒設定時，遊戲帳號登入一律回 `403`，密碼登入不受影響。

### 8. 驗證

1. 開 `https://<你的網域>/`，用密碼登入。
2. 點「開始玩」，確認遊戲能正常載入、左上角有 🚇 按鈕。
3. 蓋一條路線，在面板按「儲存目前進度」，回到管理介面確認有出現存檔。
4. 換一台裝置登入，按「載入到我的網域版」，確認進度一樣。

剛建立的網域可能要等幾分鐘 DNS 和憑證才會生效。如果本機一直連不上，見[疑難排解](#疑難排解)。

### 改密碼

再執行一次 `npx wrangler secret put APP_PASSWORD`（或在 Dashboard 修改）。token 是用密碼簽章的，所以改密碼後**所有裝置都要重新登入，所有書籤都要重新建立**。雲端存檔不受影響。如果書籤外流，改密碼就能讓它失效。

### GitHub Actions 自動部署（選用）

`.github/workflows/deploy.yml` 會在 push 到 `main`，或手動執行（workflow_dispatch）時，用 Node 22 跑 `npm ci` 和 `npx wrangler deploy`。

1. 把專案推到自己的 GitHub repo。
2. 到 Cloudflare Dashboard → My Profile → API Tokens → Create Token，用 **「Edit Cloudflare Workers」** 範本：
   - Account Resources：選你的帳號。
   - Zone Resources：選你的網域（自訂網域需要）。
   - 這個範本包含 Workers Scripts、Workers Routes、Workers R2 Storage 等需要的權限。
3. 到 GitHub repo → Settings → Secrets and variables → Actions，新增：

   | Secret | 值 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | 上一步的 API token |
   | `CLOUDFLARE_ACCOUNT_ID` | 你的 Account ID |

4. `APP_PASSWORD` **不用**放到 GitHub。它只在 Cloudflare 設定一次，之後的部署會沿用。
5. R2 bucket 要先手動建立一次（第 4 步）。

### 不用自己的網域（workers.dev）

把 `wrangler.jsonc` 改成：

```jsonc
"workers_dev": true,
// 刪掉 "routes" 這一行
```

部署後網址是 `https://metromastersync.<你的子網域>.workers.dev`，其他功能都一樣。

### 移除

```sh
npx wrangler delete                                  # 刪除 Worker（自訂網域會一起移除）
npx wrangler r2 bucket delete metromastersync-saves  # bucket 必須是空的才能刪
```

刪除 bucket 前，先到 Dashboard → R2 → bucket 刪除裡面所有物件。需要保留存檔的話，先在管理介面逐筆「下載」。

---

## 設定參數一覽

### Worker 環境變數與綁定

| 名稱 | 類型 | 預設 / 範例 | 說明 |
|---|---|---|---|
| `APP_PASSWORD` | Secret（必填） | 無 | 登入密碼，也是 token 簽章的金鑰材料 |
| `ALLOWED_ACCOUNTS` | Secret（選用） | 無 | 可以用遊戲帳號登入的 email 或 Firebase uid，逗號分隔、不分大小寫 |
| `FIREBASE_PROJECT_ID` | 一般變數 | `app-metromaster` | 遊戲的 Firebase 專案 ID，用來驗證 ID token 的 `iss` 與 `aud` |
| `GAME_ORIGIN` | 一般變數 | `https://metromaster.huangyouci.com` | 原遊戲網站的 origin。`/play/` 轉接到這裡；CORS 也允許這個 origin（給書籤用）。結尾不要加 `/`。 |
| `SAVES` | R2 綁定 | bucket `metromastersync-saves` | 存檔儲存空間 |
| `ASSETS` | 靜態資源綁定 | 目錄 `./public` | 管理介面與前端 script |

### `wrangler.jsonc` 其他欄位

| 欄位 | 值 | 說明 |
|---|---|---|
| `compatibility_date` | `2026-10-01` | Workers 執行環境版本 |
| `workers_dev` | `false` | 不開 `*.workers.dev` 網址，只用自訂網域 |
| `assets.run_worker_first` | `["/api/*"]` | `/api/*` 一律先進 Worker。`/play/*` 在 `public/` 裡沒有對應檔案，所以也會進 Worker。 |

### 硬編碼的原遊戲網址

如果原遊戲換網域，除了 `GAME_ORIGIN`，還要改這三個地方：

| 檔案 | 位置 |
|---|---|
| `public/inject.js` | `const GAME_HOST = 'metromaster.huangyouci.com'` |
| `public/core.js` | `device()` 裡的 `location.hostname === 'metromaster.huangyouci.com'` |
| `public/index.html` | `const GAME = 'https://metromaster.huangyouci.com/'` 以及說明文字的連結 |

---

## 程式內的常數與數值

### `src/worker.js`

| 常數 / 數值 | 值 | 用途 |
|---|---|---|
| `PREFIX` | `s/` | R2 中存檔物件的 key 前綴 |
| `PENDING_KEY` | `meta/pending` | 「待匯入」標記的 R2 key |
| `GAME_KEY_PREFIX` | `transit-planner:` | 存檔中每個 key 都必須以此開頭 |
| `TOKEN_TTL` | `365 * 24 * 3600` 秒（1 年） | 登入 token 與 Cookie 有效期 |
| `MAX_BODY` | `20 * 1024 * 1024`（20 MB） | 請求 `Content-Length` 上限，超過回 `413 存檔太大` |
| `VERSION_PREFIX` | `v/` | 歷史版本的 R2 key 前綴 |
| `VERSION_MIN_GAP` | 15 分鐘 | 被覆寫的舊內容距上一個版本不到這個時間就不另存 |
| `WRITE_RETRIES` | 3 | `PUT`／`PATCH` 的 R2 條件寫入（`etagMatches`）失敗時重讀再試的次數，用完回 `409` |
| `VERSION_TIERS` | 2h 全留、24h 每小時、30d 每天、180d 每週 | 歷史版本保留規則，超過最後一段刪除 |
| `USERSCRIPT_VERSION` | `1.0.0` | userscript 的 `@version`；只有 userscript 本身內容改變時才需要調高，讓管理器提示更新 |
| 密碼錯誤延遲 | 800 ms | 減緩暴力猜密碼 |
| HMAC 金鑰 | `'mms1|' + APP_PASSWORD`，SHA-256 | token 簽章 |
| Cookie 名稱 | `mms_session` | `/play/*` 的登入驗證 |
| Cookie 屬性 | `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` | |
| CORS `Access-Control-Max-Age` | `86400`（1 天） | preflight 快取 |
| CORS 允許方法 | `GET, POST, PATCH, PUT, DELETE, OPTIONS` | |
| CORS 允許標頭 | `Authorization, Content-Type` | |
| CORS 允許來源 | `GAME_ORIGIN` 與本站 origin | 其他來源不回 `Access-Control-Allow-Origin` |
| 存檔 id 格式 | `<Date.now() 的 base36>-<UUID 前 8 碼>` | 例：`mh5x2k1a-3f9c0b12`。API 路徑只接受 `[a-z0-9-]{1,40}` |
| `name` 長度上限 | 80 字元 | 超過截斷 |
| `device` 長度上限 | 60 字元 | |
| `source` 長度上限 | 20 字元 | |
| `summary` 長度上限 | 1200 字元（JSON 字串） | R2 自訂 metadata 總共只能 2KB |
| 摘要計劃數 | 最多 12 份，依車站數由多到少 | 解析 `psummary.<id>`（第 5 版）、`summary~N`（舊版）、`qsummary.<slug>`（挑戰） |
| 列表分頁 | 每次向 R2 取 1000 筆，自動翻頁到底 | |
| 列表排序 | `updatedAt` 由新到舊 | |

### `public/core.js`

| 常數 | 值 | 用途 |
|---|---|---|
| `PFX` | `transit-planner:` | 遊戲資料的 key 前綴 |
| `LOCAL_ONLY` | `transit-planner:v4:lang`、`transit-planner:house-ad-last` | 各裝置自己的設定（語言、上次顯示廣告時間），不同步 |
| 統計快取 | `transit-planner:v4:` 後面接 `stats`、`pstats.<id>`、`qstats.<slug>`、`stats~N`，可再接 `@city` | 遊戲可以重算，不上傳以節省空間 |
| 「有進度」判斷 | `/^transit-planner:v4:(?:broken\d?\.)?[pq]?save/` | 有 `psave.*`、`qsave.*` 或舊版 `save*` 才算有進度；只有解鎖紀錄、計劃清單時視為沒有進度 |
| `UNLOCK_KEY` | `transit-planner:v4:unlock` | 遊戲的商店解鎖紀錄（JSON 字串，含 `owned`、`unlocked` 等）；`applyUnlockAll` 把 `owned` 補成 `true`、保留其餘欄位，缺損才用遊戲預設建檔，是非破壞性、冪等的 |
| `mms:unlock-all` | `'1'` = 開啟 | 「解鎖全部功能」開關（定義在 `inject.js`，每台裝置、每個網域分開），預設關閉；開啟後本機的存檔/自動儲存都會補上全解 |
| 單一計劃鍵名 | `psave.<id>`、`psummary.<id>`、`pstats.<id>`、`planlist`、`qsave.<slug>`，非台北加 `@<城市>` | `listPlans`、`localPlans`、`importPlan` 用；舊版指標 `{"v":999,"moved":id}` 不算計劃 |
| 新計劃 id | 20 碼 `A-Za-z0-9`，和遊戲相同 | 只在城市沒有任何計劃、建立第 1 份時使用 |
| `IMPORT_MARK` | `mms:import-at` | 匯入時寫入時間戳，通知其他分頁 |
| `TOKEN_KEY` | `mms:token` | 登入 token |
| `CURRENT_KEY` | `mms:current` | 目前進度對應的存檔 `{id, name, source}` |
| `AUTOSAVE_ID_KEY` | `mms:autosave-id` | 自動儲存要更新的存檔 id |
| `AUTOSAVE_HASH_KEY` | `mms:autosave-hash` | 上次自動儲存（或載入）時的進度雜湊 |
| `AUTOSAVE_REV_KEY` | `mms:autosave-rev` | 這台最後同步到的雲端內容版本 |
| `CONFLICT_KEY` | `mms:autosave-conflict` | 上傳時發現的版本衝突，解決前暫停自動儲存 |
| BroadcastChannel | `mms`，訊息 `flush` / `freeze` / `unfreeze` / `reload` | 同網域分頁之間協調 |
| 裝置名稱 | 自動判斷 `iPhone`/`iPad`/`Android`/`Mac`/`Windows`/`Linux` · `Edge`/`Chrome`/`Firefox`/`Safari`；在 `/play/` 會加上「（我的網域）」 | 可在該網域的 localStorage 設定 `mms:device` 自訂 |

### `public/inject.js`

| 數值 | 值 | 用途 |
|---|---|---|
| `GAME_HOST` | `metromaster.huangyouci.com` | 書籤只在這個網域或 `/play/` 啟動，其他網站會提示前往遊戲；userscript 模式在其他網站直接不動作 |
| 啟動模式 | `/play/`、`inject.js?mode=auto`（userscript）為常駐模式；其他為書籤模式 | 常駐模式有 🚇 按鈕、自動儲存，並在其他分頁匯入後重新載入；書籤模式點一下開關面板 |
| 未連上時的 🚇 按鈕 | `opacity: .55` | 原網站常駐模式還沒換到 token 時 |
| 自動儲存間隔 `INTERVAL` | 30,000 ms | |
| 自動儲存開關 key | `mms:autosave-on` | |
| 上次自動儲存時間 key | `mms:autosave-last` | |
| keepalive 門檻 | 60,000 字元 | |
| 面板列表 | 最多 50 筆；每筆有「選計劃」（單一計劃匯入）和「載入」（整份載入） | |
| 🚇 按鈕 | `left:12px; top: safe-area + 64px`，40×40px，`z-index: 2147483646` | |
| 面板 | 最大寬度 420px，`z-index: 2147483647`，使用 Shadow DOM 隔離樣式；攔截 keydown/keyup/keypress/wheel，避免觸發遊戲快捷鍵 | |
| 面板來源標籤 | `auto-save` 自動儲存、`auto-backup` 匯入前備份 | |
| 計算監測開關 key | `mms:monitor-on` | `'1'` = 固定顯示 |
| 計算監測面板 | `left:12px; top: safe-area + 112px`，`z-index: 2147483645`，每 500ms 更新；只有按鈕可點，其他區域不擋遊戲操作 | |
| 「可能卡住」門檻 | 距上次進度超過 60 秒，且超過每回合平均時間的 6 倍 | |
| 加速計算 | 把 `budget.duty` 改成 1，不存檔，重新整理就恢復 | |

### `public/index.html`

| 數值 | 值 | 用途 |
|---|---|---|
| 通知其他分頁存檔後等待 | 300 ms | 給 `/play/` 分頁時間把記憶體中的進度寫入 |
| 凍結寫入後等待 | 150 ms | 給其他分頁時間套用凍結 |
| 提示訊息顯示時間 | 2,500 ms | |

---

## API 文件

除了 `/api/login`、`/api/login/game` 和 `/api/logout`，都需要 `Authorization: Bearer <token>` 標頭。驗證失敗回 `401 {"error":"請重新登入"}`。

所有回應都是 JSON，帶 `Cache-Control: no-store`。錯誤格式為 `{"error":"訊息"}`。

| 方法 | 路徑 | 請求內容 | 回應 |
|---|---|---|---|
| `POST` | `/api/login` | `{"password":"..."}` | `200 {"token","exp"}`，並設定 `mms_session` Cookie；密碼錯誤 `401 密碼錯誤` |
| `POST` | `/api/login/game` | `{"idToken":"<遊戲的 Firebase ID token>"}` | `200 {"token","exp","account":{"uid","email","name"}}`，並設定 Cookie；token 無效或過期 `401`；帳號不在 `ALLOWED_ACCOUNTS` `403` |
| `POST` | `/api/logout` | — | `200 {"ok":true}`，清除 Cookie |
| `GET` | `/api/me` | — | `200 {"ok":true}`（檢查 token 是否有效） |
| `POST` | `/api/session` | — | 用 Bearer token 換發 `mms_session` Cookie，到期時間與 token 相同 |
| `GET` | `/api/snapshots` | — | `{"snapshots":[Meta...],"pending":Pending\|null}` |
| `POST` | `/api/snapshots` | `{"name","device","source","pinned","data"}` | `201 {"snapshot":Meta}` |
| `GET` | `/api/snapshots/:id` | — | `{"snapshot":Meta,"data":Data}` |
| `PATCH` | `/api/snapshots/:id` | `{"name"?, "pinned"?}` | `{"snapshot":Meta}`，只改 metadata |
| `PUT` | `/api/snapshots/:id` | `{"data","name"?,"device"?,"baseRev"?}` | `{"snapshot":Meta}`，覆寫內容並把 `rev` +1；保留建立時間、來源、釘選。覆寫前會依[歷史版本](#歷史版本)規則保存舊內容。帶 `baseRev` 且和雲端 `rev` 不同時回 `409 {"error","conflict":true,"snapshot":Meta}`（雲端目前的資訊），不覆寫；同時寫入重試 3 次仍失敗也回 `409` |
| `DELETE` | `/api/snapshots/:id` | — | `{"ok":true}`；如果它是待匯入，會一起清除；歷史版本也一起刪除 |
| `GET` | `/api/snapshots/:id/versions` | — | `{"versions":[Version...]}`，由新到舊；存檔不存在 `404` |
| `GET` | `/api/snapshots/:id/versions/:vid` | — | `{"version":Version,"data":Data}`；版本不存在 `404` |
| `POST` | `/api/snapshots/:id/versions/:vid/restore` | `{"name"?}` | `201 {"snapshot":Meta}`，複製成一筆 `source=restore` 的新存檔；沒給名稱時用「原名稱（YYYY-MM-DD HH:MM UTC 版本）」 |
| `GET` | `/api/pending` | — | `{"pending":Pending\|null}` |
| `PUT` | `/api/pending` | `{"id"}` | `{"pending":Pending}`；存檔不存在回 `404` |
| `DELETE` | `/api/pending` | — | `{"ok":true}` |
| `GET` | `/mms.user.js` | — | 原網站用的 userscript，`@match` 原遊戲網址，載入 `<本站>/inject.js?mode=auto`；`Cache-Control: no-cache` |
| `GET`/`HEAD` | `/play`、`/play/*` | Cookie `mms_session` | 轉接 `GAME_ORIGIN`。`/play` 會 `301` 到 `/play/`；未登入 `302` 到 `/?next=play` |

其他錯誤碼：`409`（`PUT` 版本衝突，或 `PATCH`／`PUT` 同時被其他請求寫入）、`400`（JSON 格式錯誤、存檔格式錯誤、空存檔、key 不合法）、`404`（找不到存檔／API）、`413`（超過 20MB）、`500`（未設定密碼或伺服器錯誤）。

範例：

```sh
BASE=https://sync.example.com
TOKEN=$(curl -s -X POST $BASE/api/login -H 'Content-Type: application/json' \
  -d '{"password":"你的密碼"}' | jq -r .token)

curl -s $BASE/api/snapshots -H "Authorization: Bearer $TOKEN" | jq '.snapshots[0]'
curl -s $BASE/api/snapshots/<id> -H "Authorization: Bearer $TOKEN" | jq .data > save.json
```

---

## 資料格式

### Data（存檔內容）

和遊戲內建的備份格式相同：

```json
{
  "version": 1,
  "keys": {
    "transit-planner:v4:save": "...",
    "transit-planner:v4:summary": "{\"stations\":12,\"lines\":3,\"riders\":45678}",
    "transit-planner:v4:city": "taipei"
  }
}
```

規則：`version` 必須是 `1`，`keys` 不能是空的，每個 key 都要以 `transit-planner:` 開頭，值必須是字串。

遊戲常見的 key（都在 `transit-planner:v4:` 之後；台北不加 `@city`，其他城市加 `@<城市>`）：

| key | 內容 |
|---|---|
| `planlist[@city]` | 計劃清單 `{"ids":["<20 碼 id>",...],"current":"<id>"}`，順序就是遊戲裡的「第 N 份」 |
| `psave.<id>[@city]` | 計劃存檔（第 5 版），可能是壓縮格式 |
| `psummary.<id>[@city]` | 計劃摘要 JSON（`riders`、`stations`、`lines` 等） |
| `pstats.<id>[@city]` | 計劃統計快取，遊戲會重算 |
| `qsave.<slug>`、`qsummary.<slug>`、`qstats.<slug>` | 挑戰模式 |
| `save~N`、`summary~N`、`stats~N` | 舊版計劃鍵名。遊戲升級時會把舊進度搬到 `p*.<id>`，`save~N` 留下來當指向新 id 的指標，`summary~N`、`stats~N` 刪除 |
| `planmove[@city]` | 舊編號 → 新 id 的對照表（升級用） |
| `unlock`、`records`、`city`、`lang` 等 | 解鎖紀錄、紀錄、上次的城市、語言 |

### Meta（存檔資訊）

```json
{
  "id": "mh5x2k1a-3f9c0b12",
  "name": "我的台北",
  "device": "iPhone · Safari（我的網域）",
  "source": "auto-save",
  "createdAt": 1761811200000,
  "updatedAt": 1761814800000,
  "pinned": false,
  "rev": 3,
  "size": 48213,
  "keyCount": 14,
  "summary": {
    "city": "taipei",
    "slots": [{ "c": "taipei", "p": 1, "st": 12, "l": 3, "r": 45678 }]
  }
}
```

| 欄位 | 說明 |
|---|---|
| `source` | `manual`、`auto-save`、`auto-backup`、`upload`，也可以是其他自訂字串 |
| `createdAt` / `updatedAt` | 毫秒時間戳 |
| `rev` | 內容版本號：新建是 1，每次 `PUT` 覆寫內容 +1，改名、釘選不變；這個功能之前建立的存檔是 0 |
| `size` | R2 物件大小（bytes） |
| `summary.slots[].c` | 城市代碼 |
| `summary.slots[].p` | 計劃編號（數字，`planlist` 裡的順序，從 1 開始；不在清單裡是 `"?"`；舊版存檔是 `~N` 的 N），或挑戰 `q:<代碼>` |
| `summary.slots[].st` / `l` / `r` | 車站數 / 路線數 / 日運量 |

### Version（歷史版本資訊）

```json
{
  "vid": "0mw2nbg5q",
  "at": 1793828742542,
  "device": "Mac · Chrome",
  "keyCount": 12,
  "size": 48213,
  "summary": { "city": null, "slots": [ { "c": "taipei", "p": 0, "st": 11, "l": 3, "r": 52000 } ] }
}
```

`vid` 是 `at`（版本內容的時間，即被覆寫前的 `updatedAt`）的 base36，補零到 9 碼。`summary` 格式和 Meta 相同。

### Pending（待匯入）

```json
{ "id": "mh5x2k1a-3f9c0b12", "name": "我的台北", "at": 1761811200000 }
```

### R2 儲存結構

| R2 key | 內容 |
|---|---|
| `s/<id>` | Data JSON；metadata 存在 R2 自訂 metadata（`name`、`device`、`source`、`createdAt`、`updatedAt`、`pinned`=`'1'`/`'0'`、`keyCount`、`summary`） |
| `v/<id>/<vid>` | 自動儲存 `<id>` 的歷史版本，內容是 Data JSON；`<vid>` 是版本時間（毫秒）的 base36，補零到 9 碼以便依字串排序；metadata 有 `device`、`keyCount`、`summary` |
| `meta/pending` | Pending JSON |

---

## 瀏覽器 localStorage 使用的 key

| Key | 網域 | 說明 |
|---|---|---|
| `transit-planner:*` | 原網站 / 你的網域 | 遊戲本身的資料 |
| `mms:token` | 你的網域、原網站（遊戲帳號登入換發） | 登入 token |
| `mms:current` | 你的網域（`/play/`）或原網站 | 目前進度來自哪筆存檔 |
| `mms:import-at` | 同上 | 最近一次匯入的時間戳 |
| `mms:autosave-on` | 你的網域、原網站 | 自動儲存開關 |
| `mms:autosave-id` | 你的網域、原網站 | 自動儲存更新的存檔 id |
| `mms:autosave-hash` | 你的網域 / 原網站 | 上次自動儲存或載入的雜湊 |
| `mms:autosave-rev` | 你的網域、原網站 | 這台最後同步到的雲端內容版本，自動儲存上傳時當作 `baseRev` |
| `mms:autosave-conflict` | 你的網域、原網站 | 雲端已被其他裝置更新時的資訊 `{id,name,rev,device,updatedAt}`；有值時暫停自動儲存 |
| `mms:autosave-last` | 你的網域、原網站 | 上次自動儲存時間 |
| `mms:device` | 任一 | 選填，自訂裝置名稱 |
| `mms:unlock-all` | 你的網域、原網站 | 選填，`'1'` 開啟「解鎖全部功能」（預設關閉）；開啟後本機存檔/自動儲存補 `owned:true` |
| `mms:monitor-on` | 你的網域、原網站 | 選填，`'1'` 固定顯示計算監測面板（預設關閉） |

---

## 安全性

- **只有一組密碼**，沒有多使用者；所有登入的人看到同一份雲端存檔。適合個人使用。
- 遊戲帳號登入：Worker 用 Google 公開金鑰（`securetoken@system.gserviceaccount.com` 的 JWKS）驗證 RS256 簽章，並檢查 `iss`、`aud`、`exp`、`iat`、`auth_time`，拒絕匿名帳號，最後比對 `ALLOWED_ACCOUNTS`。Firebase ID token 只用來換發本站 token，不會儲存。
- 書籤在遊戲頁只會讀取 Firebase 的 IndexedDB，不會寫入。ID token 快過期時，會用 refresh token 向 Google 換一個新的，但不會寫回遊戲。這是依賴遊戲目前的實作，如果遊戲改了登入方式，就要改回密碼或內含登入資訊的書籤。
- 密碼比對使用 HMAC 加上 `timingSafeEqual`，避免時序攻擊；密碼錯誤會延遲 800ms 才回應。沒有鎖定次數，所以請用夠長的隨機密碼。
- token 格式 `<到期秒數>.<HMAC-SHA256 簽章 base64url>`，伺服器不儲存 session，改密碼就會讓所有 token 失效。
- `/play/*` 用 HttpOnly + Secure + SameSite=Lax 的 Cookie 驗證，網頁上的 JavaScript 讀不到。
- API 只接受 Bearer token（不看 Cookie），所以不會被 CSRF 利用。
- CORS 只允許 `GAME_ORIGIN` 和本站。
- 書籤網址內含 token，等同密碼，不要分享或貼到公開的地方。
- `/play/` 的頁面加上 `noindex, nofollow`，不會被搜尋引擎收錄。
- 請只部署給自己使用。不要公開轉接原遊戲，也不要拿來營利，並尊重原作者的權利。

---

## 費用與用量

一般個人使用都在免費額度內：

| 服務 | 免費額度（以 Cloudflare 官方公告為準） | 本工具的用量 |
|---|---|---|
| Workers | 每天 100,000 次請求 | 開 `/play/` 時會轉接遊戲的每個資源。自動儲存在進度有變動時最多每 30 秒 1 次（每小時約 120 次） |
| R2 儲存 | 10 GB / 月 | 每筆存檔通常幾十 KB；每筆自動儲存另有約 80 份歷史版本 |
| R2 寫入（Class A） | 每月 100 萬次 | 每次儲存 1 次，列表 1 次；自動儲存覆寫時多 1 次列出歷史版本，最多每 15 分鐘多 1 次寫入版本 |
| R2 讀取（Class B） | 每月 1,000 萬次 | |

存檔不會自動清除（歷史版本例外，依保留規則自動清理）。如果「匯入前備份」或舊存檔太多，可以在管理介面刪除。

---

## 本機開發

```sh
echo 'APP_PASSWORD=test123' > .dev.vars   # .dev.vars 已在 .gitignore
npm run dev                                # wrangler dev，預設 http://localhost:8787
```

- 本機的 R2 是模擬的，資料放在 `.wrangler/`。
- `/play/` 在本機也能用（會連到真正的原遊戲網站）。
- 書籤方式在本機測不了：從 https 的原遊戲網站連到 `http://localhost`，會被瀏覽器的 Private / Local Network Access 擋下。請部署後再測。
- 程式碼沒有建置步驟，`public/` 是直接提供的靜態檔。

---

## 疑難排解

| 狀況 | 原因與解法 |
|---|---|
| 部署時出現 `Could not find zone for <網域>` | 網域不在 `account_id` 指定的帳號裡。用 `npx wrangler whoami` 確認帳號，把 `account_id` 改成擁有該網域的帳號。 |
| 部署時出現 R2 bucket 不存在 | 先執行 `npx wrangler r2 bucket create <bucket 名稱>`，名稱要和 `wrangler.jsonc` 一致。 |
| 部署時出現自訂網域已有 DNS 記錄 | 到 DNS 刪除該主機名稱原本的記錄，或換一個子網域。 |
| 剛部署完本機一直連不上 | 本機 DNS 可能快取了「查無此網域」。macOS：`sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`；或用手機網路試試。 |
| 登入時顯示「尚未設定 APP_PASSWORD」 | 執行 `npx wrangler secret put APP_PASSWORD`。 |
| 書籤顯示「請重新登入」 | 密碼已更改，或 token 超過一年。到管理介面重新登入並重新建立書籤。 |
| 點書籤沒反應（iPhone） | Safari 不能從網址列直接執行 `javascript:`，要從書籤選單點它。確認書籤網址是以 `javascript:` 開頭的完整內容。 |
| 點書籤跳出「請在遊戲頁面使用」 | 只能在 `metromaster.huangyouci.com` 或 `/play/` 頁面使用。 |
| 自動儲存顯示「失敗：…」 | 網路斷線或登入失效。恢復後下一個 30 秒週期會自動重試；登入失效就到管理介面重新登入。 |
| 載入後進度沒變 | 確認載入時沒有其他瀏覽器分頁在原網站開著遊戲（原網站分頁不會收到重新整理通知）。 |
| 大計劃一直顯示「計算中」 | 打開計算監測面板看回合數有沒有在增加。有在增加就是正常在算：改完後回到首頁或切到別的分頁，計算會用 100% 的速度跑。 |
| 排行榜沒更新 | 用「排行榜檢查」確認計劃可上哪個榜（收支比未滿 100% 上不了「收支平衡」）、正式統計是否算完；上榜不是即時的，回首頁觸發同步後等一下。 |
| `/play/` 一直跳回登入頁 | Cookie 被清掉或過期。到管理介面登入一次就會重新設定 Cookie。 |

---

## 已知限制

- 兩台裝置同時開著同一筆自動儲存在玩時，後上傳的那台會被擋下並提醒（見[防止兩台裝置互相覆蓋](#防止兩台裝置互相覆蓋)），但仍要自己選擇保留哪一份；兩邊的變更不會自動合併。
- 原網站用書籤時，自動儲存要先點一次書籤才會啟動，重新整理或重新開啟遊戲後要再點一次；用 userscript 就沒有這個限制。
- userscript 需要瀏覽器支援擴充功能。Android 版 Chrome 不行，請改用 Firefox；把遊戲「加入主畫面」以 App 模式開啟時，userscript 和書籤都不會執行。
- `/play/` 不能使用遊戲帳號相關功能：Google／Apple 登入、排行榜、自訂帳號名稱、帳號買斷，以及遊戲內建的雲端同步。遊戲的 Firebase 只允許原網站登入，API 金鑰也限制了來源網域，帳號後端還有 App Check（reCAPTCHA Enterprise）。要用這些功能請在原網站玩。
- 看廣告逐項取得的解鎖存在 `transit-planner:v4:unlock`，會跟著存檔同步到 `/play/`；帳號買斷的解鎖不會。
- 遊戲帳號登入依賴遊戲目前把 Firebase 登入狀態存在 IndexedDB `firebaseLocalStorageDb` 的做法，遊戲改版時可能失效，屆時改用密碼或內含登入資訊的書籤。
- `/play/` 和原網站的進度存在不同網域，彼此不會自動同步，要透過雲端存檔轉移。
- 程式依賴遊戲目前的資料格式（`transit-planner:` 前綴、`.promo-sheet`、`.get-app .play-web` 等）。原遊戲大改版時可能需要調整。
- 原遊戲如果加上 CSP，書籤方式會失效；`/play/` 會移除 CSP，所以不受影響。
- 列表沒有分頁，存檔數量到上千筆時載入會變慢。

---

## 專案結構

```
metro-master-sync/
├─ wrangler.jsonc               # Worker 設定：網域、R2、靜態檔、環境變數
├─ package.json                 # 只有 wrangler 一個開發依賴
├─ src/
│  └─ worker.js                 # API、認證、/play/ 轉接與注入、產生 userscript
├─ public/                      # 靜態檔（ASSETS）
│  ├─ index.html                # 管理介面
│  ├─ core.js                   # 共用：讀寫 localStorage、凍結寫入、雜湊、API client
│  └─ inject.js                 # 遊戲頁上的 🚇 面板、自動儲存、略過下載 App 對話框
└─ .github/workflows/deploy.yml # push 到 main 時自動部署
```
