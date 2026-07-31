import { useCallback, useState } from "react";
import {
  PROTOCOL_VERSION,
  type MentionCandidate,
  type PanelRequest,
  type PluginEvent,
} from "../shared/protocol";

interface MentionPickerState {
  readonly open: boolean;
  readonly query: string;
  readonly requestId: string | null;
  readonly candidates: readonly MentionCandidate[];
  readonly loading: boolean;
}

interface MentionPickerActions {
  readonly openAt: (query: string) => void;
  readonly setQuery: (query: string) => void;
  readonly dismiss: () => void;
  readonly select: (candidate: MentionCandidate) => void;
}

interface MentionPicker extends MentionPickerState, MentionPickerActions {}

interface MentionPickerDeps {
  readonly chatId: string | undefined;
  readonly send: (request: PanelRequest) => void;
  readonly onAttach: (candidate: MentionCandidate) => void;
  readonly consumeResults: (handler: MentionResultsHandler) => () => void;
}

type MentionResultsHandler = (
  event: Extract<PluginEvent, { type: "mention.results" }>,
) => void;

const INITIAL: MentionPickerState = {
  open: false,
  query: "",
  requestId: null,
  candidates: [],
  loading: false,
};

function requestEnvelope(
  chatId: string,
  requestId: string,
): Pick<PanelRequest, "version" | "messageId" | "chatId"> {
  return { version: PROTOCOL_VERSION, messageId: requestId, chatId };
}

/**
 * Owns @-mention picker state: open/query/results/dismiss and candidate attach.
 *
 * @example const picker = useMentionPicker({ chatId, send, onAttach, consumeResults })
 */
export function useMentionPicker(deps: MentionPickerDeps): MentionPicker {
  const [state, setState] = useState<MentionPickerState>(INITIAL);

  const sendSearch = useCallback(
    (query: string) => {
      if (!deps.chatId) return;
      const requestId = crypto.randomUUID();
      setState((current) => ({
        ...current,
        query,
        requestId,
        loading: true,
      }));
      deps.send({
        ...requestEnvelope(deps.chatId, requestId),
        type: "mention.search",
        payload: { query, requestId },
      });
    },
    [deps],
  );

  const openAt = useCallback(
    (query: string) => {
      setState({ ...INITIAL, open: true });
      sendSearch(query);
    },
    [sendSearch],
  );

  const setQuery = useCallback(
    (query: string) => {
      setState((current) => ({ ...current, query }));
      sendSearch(query);
    },
    [sendSearch],
  );

  const dismiss = useCallback(() => setState(INITIAL), []);

  const select = useCallback(
    (candidate: MentionCandidate) => {
      deps.onAttach(candidate);
      setState(INITIAL);
    },
    [deps],
  );

  deps.consumeResults((event) => {
    if (event.type !== "mention.results") return;
    setState((current) => {
      if (current.requestId !== event.payload.requestId) return current;
      return {
        ...current,
        candidates: event.payload.candidates,
        loading: false,
      };
    });
  });

  return { ...state, openAt, setQuery, dismiss, select };
}
