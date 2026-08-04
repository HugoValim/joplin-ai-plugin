import { PROTOCOL_VERSION, type PanelRequest } from "../../src/shared/protocol";
import type { ChangeReviewIntent } from "../../src/webview/ChangeReview";
import {
  ChangeReviewTransportAdapter,
  type ChangeReviewTransportPorts,
} from "../../src/webview/changeReviewTransport";

class FakeChangeReviewPorts implements ChangeReviewTransportPorts {
  public readonly phases: { readonly runId: string; readonly phase: string }[] =
    [];
  public readonly requests: PanelRequest[] = [];

  public readonly envelope = (): Pick<
    PanelRequest,
    "version" | "messageId" | "chatId"
  > => ({
    version: PROTOCOL_VERSION,
    messageId: "message-1",
    chatId: "chat-1",
  });

  public readonly begin = (runId: string, phase: string): void => {
    this.phases.push({ runId, phase });
  };

  public readonly post = (request: PanelRequest): void => {
    this.requests.push(request);
  };
}

const CONTEXT = { changeSetId: "changes-1", runId: "run-1" } as const;

describe("ChangeReviewTransportAdapter", () => {
  test.each<{
    readonly intent: Exclude<ChangeReviewIntent, { type: "open" }>;
    readonly request: Partial<PanelRequest>;
  }>([
    {
      intent: {
        ...CONTEXT,
        type: "apply",
        phase: "Applying changes",
        acceptedIds: ["change-1"],
        applyToken: "a".repeat(64),
      },
      request: {
        type: "changes.apply",
        payload: {
          changeSetId: "changes-1",
          acceptedIds: ["change-1"],
          applyToken: "a".repeat(64),
        },
      },
    },
    {
      intent: { ...CONTEXT, type: "discard", phase: "Discarding changes" },
      request: {
        type: "changes.discard",
        payload: { changeSetId: "changes-1" },
      },
    },
    {
      intent: {
        ...CONTEXT,
        type: "deny",
        phase: "Denying and restoring changes",
      },
      request: {
        type: "changes.deny",
        payload: { changeSetId: "changes-1" },
      },
    },
    {
      intent: {
        ...CONTEXT,
        type: "keep",
        phase: "Keeping changes",
        changeIds: ["change-1"],
      },
      request: {
        type: "changes.keep",
        payload: { changeSetId: "changes-1", changeIds: ["change-1"] },
      },
    },
    {
      intent: {
        ...CONTEXT,
        type: "undo",
        phase: "Undoing changes",
        changeIds: ["change-1"],
      },
      request: {
        type: "changes.undo",
        payload: { changeSetId: "changes-1", changeIds: ["change-1"] },
      },
    },
  ])(
    "converts $intent.type intent and begins its phase",
    ({ intent, request }) => {
      const ports = new FakeChangeReviewPorts();
      new ChangeReviewTransportAdapter(ports).send(intent);

      expect(ports.phases).toEqual([{ runId: "run-1", phase: intent.phase }]);
      expect(ports.requests).toEqual([
        expect.objectContaining({ ...request, runId: "run-1" }),
      ]);
    },
  );

  test("opens the Review Note without beginning a busy phase", () => {
    const ports = new FakeChangeReviewPorts();
    new ChangeReviewTransportAdapter(ports).send({
      ...CONTEXT,
      type: "open",
    });

    expect(ports.phases).toEqual([]);
    expect(ports.requests).toEqual([
      expect.objectContaining({
        type: "review.open",
        runId: "run-1",
        payload: { changeSetId: "changes-1" },
      }),
    ]);
  });
});
