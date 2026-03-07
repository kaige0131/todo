require("dotenv").config();
const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const FEISHU_APP_ID     = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const SILICONFLOW_KEY   = process.env.SILICONFLOW_API_KEY;
const PORT              = process.env.PORT || 3000;

let _token = null, _tokenExpiry = 0;
async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const r = await axios.post(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }
  );
  _token = r.data.tenant_access_token;
  _tokenExpiry = Date.now() + (r.data.expire - 60) * 1000;
  return _token;
}

const buffer = {};

async function sendToGroup(chatId, markdown) {
  const token = await getToken();
  await axios.post(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify({
        config: { wide_screen_mode: true },
