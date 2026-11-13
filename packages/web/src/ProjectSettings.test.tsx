// @vitest-environment jsdom
import type { StageModels, TicketReviewMode } from "@afk/shared";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { emptyWorkbench, fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type ProjectDetail = {
  id: number;
  name: string;
  defaultAgent: null;
  feishuChatId: string | null;
  ticketReview: TicketReviewMode;
  stageModels: StageModels;
  repos: {
    name: string;
    url: string;
    defaultBranch: string;
    contractPath: string | null;
    hostKind: string;
  }[];
};

const projectDetail = (repos: ProjectDetail["repos"]): ProjectDetail => ({
  id: 1,
  name: "shop",
  defaultAgent: null,
  feishuChatId: "oc_shop",
  ticketReview: "spec",
  stageModels: {},
  repos,
});

const workbench = () => ({
  "GET /workbench": () => ({
    json: {
      ...emptyWorkbench,
      status: {
        ...emptyWorkbench.status,
        feishu: { open: false, closedReason: "missing" },
      },
    },
  }),
});

describe("the project Feishu page", () => {
  it("lets you change the Feishu chat id, see a closed channel, and send a test card, and has no default-model or concurrency controls", async () => {
    const project = projectDetail([]);
    const fake = fakeServer({
      ...workbench(),
      "GET /projects/1": () => ({ json: project }),
      "PATCH /projects/1": ({ body }) => {
        const chat = (body as { feishuChatId?: string }).feishuChatId;
        project.feishuChatId = chat && chat.length > 0 ? chat : null;
        return { json: { id: 1 } };
      },
      "POST /projects/1/feishu-test": () => ({
        json: { sent: true, chatId: "oc_next" },
      }),
    });
    renderWithApp(<ProjectSettings projectId={1} />, fake);
    expect(await screen.findByLabelText("飞书群 ID")).toBeTruthy();
    expect((screen.getByLabelText("飞书群 ID") as HTMLInputElement).value).toBe(
      "oc_shop",
    );
    expect(screen.getByTestId("feishu-closed").textContent).toContain(
      "密钥文件不存在",
    );
    expect(screen.getByTestId("feishu-closed").textContent).toContain(
      "app.json",
    );
    expect(screen.getByLabelText("飞书通知").textContent).toContain("oc_ 开头");
    expect(screen.getByLabelText("飞书通知").textContent).toContain(
      "把这个应用的机器人拉进",
    );
    expect(screen.queryByLabelText(/并发/)).toBeNull();
    expect(screen.queryByText(/maxConcurrency/i)).toBeNull();
    expect(screen.queryByText(/defaultModel/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("飞书群 ID"), {
      target: { value: "oc_next" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存群号" }));
    await waitFor(() => expect(fake.calls).toContain("PATCH /projects/1"));
    fireEvent.click(screen.getByRole("button", { name: "测试发送" }));
    expect(await screen.findByText("已发送到 oc_next")).toBeTruthy();
    expect(fake.calls).toContain("POST /projects/1/feishu-test");
  });

  it("checks GitHub access only when 现在检查 is clicked", async () => {
    const fake = fakeServer({
      ...workbench(),
      "GET /projects/1": () => ({
        json: projectDetail([
          {
            name: "backend",
            url: "https://github.com/acme/shop-backend.git",
            defaultBranch: "main",
            contractPath: null,
            hostKind: "github",
          },
          {
            name: "other",
            url: "https://gitlab.com/acme/other.git",
            defaultBranch: "main",
            contractPath: null,
            hostKind: "gitlab",
          },
        ]),
      }),
      "GET /projects/1/repos/backend/access": () => ({
        json: { state: "unchecked" },
      }),
      "GET /projects/1/repos/other/access": () => ({
        json: { state: "unchecked" },
      }),
      "POST /projects/1/repos/backend/access-check": () => ({
        json: { state: "ok", checkedAt: "2026-11-01T00:00:00.000Z" },
      }),
    });
    renderWithApp(<ProjectSettings projectId={1} />, fake);
    expect(fake.calls).not.toContain(
      "POST /projects/1/repos/backend/access-check",
    );
    const checkButtons = await screen.findAllByRole("button", {
      name: "现在检查",
    });
    expect(checkButtons).toHaveLength(2);
    expect(fake.calls).toContain("GET /projects/1/repos/backend/access");
    expect(fake.calls).toContain("GET /projects/1/repos/other/access");
    fireEvent.click(checkButtons[0] as HTMLElement);
    await waitFor(() =>
      expect(fake.calls).toContain(
        "POST /projects/1/repos/backend/access-check",
      ),
    );
  });

  it("saves a typed chat id when 测试发送 is clicked, and explains a missing chat in Chinese", async () => {
    const project = projectDetail([]);
    project.feishuChatId = null;
    const fake = fakeServer({
      ...workbench(),
      "GET /projects/1": () => ({ json: project }),
      "PATCH /projects/1": ({ body }) => {
        const chat = (body as { feishuChatId?: string }).feishuChatId;
        project.feishuChatId = chat && chat.length > 0 ? chat : null;
        return { json: { id: 1 } };
      },
      "POST /projects/1/feishu-test": () => ({
        json: { sent: true, chatId: "oc_typed" },
      }),
    });
    renderWithApp(<ProjectSettings projectId={1} />, fake);
    fireEvent.change(await screen.findByLabelText("飞书群 ID"), {
      target: { value: "oc_typed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "测试发送" }));
    expect(await screen.findByText("已发送到 oc_typed")).toBeTruthy();
    expect(fake.calls).toContain("PATCH /projects/1");
    expect(fake.calls).toContain("POST /projects/1/feishu-test");
  });

  it("turns the test-send refusal into a how-to, not the English error", async () => {
    const fake = fakeServer({
      ...workbench(),
      "GET /projects/1": () => ({ json: projectDetail([]) }),
      "POST /projects/1/feishu-test": () => ({
        status: 409,
        json: { error: "no Feishu chat configured" },
      }),
    });
    renderWithApp(<ProjectSettings projectId={1} />, fake);
    fireEvent.click(await screen.findByRole("button", { name: "测试发送" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("还没保存群号");
    expect(alert.textContent).toContain("oc_");
    expect(alert.textContent).not.toContain("no Feishu chat configured");
  });

  it("lets you see and change ticketReview", async () => {
    const project = projectDetail([]);
    const fake = fakeServer({
      ...workbench(),
      "GET /projects/1": () => ({ json: project }),
      "PATCH /projects/1": ({ body }) => {
        const next = (body as { ticketReview?: TicketReviewMode }).ticketReview;
        if (next) project.ticketReview = next;
        return { json: { id: 1 } };
      },
    });
    renderWithApp(<ProjectSettings projectId={1} />, fake);
    const select = (await screen.findByRole("combobox", {
      name: "票级审查",
    })) as HTMLSelectElement;
    expect(select.value).toBe("spec");
    fireEvent.change(select, { target: { value: "both" } });
    fireEvent.click(screen.getByRole("button", { name: "保存审查设置" }));
    await waitFor(() => expect(fake.calls).toContain("PATCH /projects/1"));
    expect(project.ticketReview).toBe("both");
  });

  it("lets you see and change stageModels", async () => {
    const project = projectDetail([]);
    const fake = fakeServer({
      ...workbench(),
      "GET /projects/1": () => ({ json: project }),
      "PATCH /projects/1": ({ body }) => {
        const next = (body as { stageModels?: StageModels }).stageModels;
        if (next) project.stageModels = next;
        return { json: { id: 1 } };
      },
    });
    renderWithApp(<ProjectSettings projectId={1} />, fake);
    const standards = (await screen.findByLabelText(
      "standards",
    )) as HTMLInputElement;
    expect(standards.value).toBe("");
    fireEvent.change(standards, { target: { value: "standards-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存阶段模型" }));
    await waitFor(() => expect(fake.calls).toContain("PATCH /projects/1"));
    expect(project.stageModels.standards).toBe("standards-model");
  });
});
