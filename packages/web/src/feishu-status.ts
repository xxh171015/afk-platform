export function feishuClosedMessage(feishu: {
  open: boolean;
  closedReason: "missing" | "permissions" | "invalid" | null;
}): string | null {
  if (feishu.open) return null;
  if (feishu.closedReason === "permissions")
    return "飞书渠道已关闭：密钥文件权限过宽";
  if (feishu.closedReason === "invalid") return "飞书渠道已关闭：密钥文件无效";
  return "飞书渠道已关闭：密钥文件不存在";
}

const SECRETS_FIX =
  '把应用密钥写成 {"app_id","app_secret"} 放到 ~/.afk/secrets/feishu/app.json，权限仅自己可读（chmod 600 这个文件），然后重启 API。';

export function describeFeishuActionError(
  message: string,
  closed: string | null,
): string {
  if (message === "no Feishu chat configured") {
    return "还没保存群号。群 ID 是 oc_ 开头的一串，填好后先点「保存群号」，再测发送。";
  }
  if (message === "feishu channel is closed") {
    return closed
      ? `${closed}。${SECRETS_FIX}`
      : `飞书渠道已关闭。${SECRETS_FIX}`;
  }
  if (message === "feishu send failed") {
    return "飞书没收下这条测试。确认已经把应用机器人拉进这个群、群 ID 没贴错，并且应用开通了发消息权限。";
  }
  if (message === "the request failed") return "请求没成功，请再试一次。";
  return message;
}
