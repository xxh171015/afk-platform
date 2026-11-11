// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { emptyWorkbench, fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

const project: {
  id: number;
  name: string;
  defaultAgent: null;
  feishuChatId: string | null;
  repos: [];
} = {
  id: 1,
  name: "shop",
  defaultAgent: null,
  feishuChatId: "oc_shop",
  repos: [],
};

describe("the project Feishu page", () => {
  it("lets you change the Feishu chat id, see a closed channel, and send a test card, and has no model or concurrency controls", async () => {
    const fake = fakeServer({
      "GET /workbench": () => ({
        json: {
          ...emptyWorkbench,
          status: {
            ...emptyWorkbench.status,
            feishu: { open: false, closedReason: "missing" },
          },
        },
      }),
      "GET /projects/1": () => ({ json: project }),
      "PATCH /projects/1": ({ body }) => {
        const chat = (body as { feishuChatId?: string }).feishuChatId;
        project.feishuChatId = chat ?? null;
        return { json: { id: 1 } };
      },
      "POST /projects/1/feishu-test": () => ({
        json: { sent: true, chatId: "oc_next" },
      }),
    });
    renderWithApp(<ProjectSettings projectId={1} />, fake);
    expect(await screen.findByLabelText("飞书群 chat_id")).toBeTruthy();
    expect(
      (screen.getByLabelText("飞书群 chat_id") as HTMLInputElement).value,
    ).toBe("oc_shop");
    expect(screen.getByTestId("feishu-closed").textContent).toContain(
      "密钥文件不存在",
    );
    expect(screen.queryByLabelText(/模型/)).toBeNull();
    expect(screen.queryByLabelText(/并发/)).toBeNull();
    expect(screen.queryByText(/maxConcurrency/i)).toBeNull();
    expect(screen.queryByText(/defaultModel/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("飞书群 chat_id"), {
      target: { value: "oc_next" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存群号" }));
    await waitFor(() => expect(fake.calls).toContain("PATCH /projects/1"));
    fireEvent.click(screen.getByRole("button", { name: "测试发送" }));
    expect(await screen.findByText("已发送到 oc_next")).toBeTruthy();
    expect(fake.calls).toContain("POST /projects/1/feishu-test");
  });
});
