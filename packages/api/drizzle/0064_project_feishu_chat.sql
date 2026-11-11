-- Feishu group chat_id for this project's notifications. Null until plat project edit --feishu-chat.
ALTER TABLE "projects" ADD COLUMN "feishu_chat_id" text;
