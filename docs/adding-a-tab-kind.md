# Adding a kind of tab

The artifact pane beside the chat shows tabs. Each tab has a **kind**: a file (M19b), an aside (M20b), the session's sub-agents (M100, M106), a plan (M22b) and an image (M23) today; media (M25) later. The pane names no kind. Adding one is a folder and a line.

Written with M19b (C4, C5). The `file` kind, in [`src/renderer/src/artifacts/file/`](../src/renderer/src/artifacts/file/), is the example throughout; the `aside` kind, in [`src/renderer/src/artifacts/aside/`](../src/renderer/src/artifacts/aside/), added by M20b (C36–C43), is the example of a tab that holds an input and keeps a draft; the `agents` kind, in [`src/renderer/src/artifacts/agents/`](../src/renderer/src/artifacts/agents/), added by M100 (round 8, C78) and made a stack by M106 (C1–C4, C40–C44), is the example of a tab that opens by itself, cannot be closed, changes while it is shown and reads a conversation by `MessageList` — a sub-agent's thread, unfolded under its row, which M20a's `worker` kind drew in a tab of its own until M106 retired it; and the `plan` kind, in [`src/renderer/src/artifacts/plan/`](../src/renderer/src/artifacts/plan/), added by M22b (C25, C60), is the example of a tab whose text may be long, read range by range.

## What a tab is

A tab is a kind, a **reference** and a title.

- The reference is a value your kind alone reads, which the pane can compare and write as JSON: a file's real path, an aside's id, a plan's id; `null` for the one tab a session has of a kind, as the Sub-agents tab is. A session has one tab for a kind and a reference: opening what is open selects it.
- Tabs are a session's, and last for the run. Nothing of them is stored, and a restart begins with none.

## The steps

1. **Make a folder** under `src/renderer/src/artifacts/`, named for your kind.
2. **Define the kind** with `tabKind` from [`tab-kind.ts`](../src/renderer/src/artifacts/tab-kind.ts):

   ```ts
   export const planKind = tabKind<string, PlanViewState>({
     id: 'plan',
     title: () => 'Plan',
     Body: PlanBody,
     Watcher: PlanWatcher,
   });
   ```

   - `id` is what a tab is opened by.
   - `title` gives a reference its title. `others` are the session's other references of your kind, so that two of one name can tell themselves apart: two files named `README.md` each add their folder's name.
   - `Body` draws the tab's whole body. Begin it with the shared `ArtifactBar`, supplying the type label and applicable actions. Keep the bar outside the content scroller, including loading and error states. Copy stands last for file and image tabs; a plan's confirmed Remove is a trash icon at the far right. A label alone is enough for conversational tabs.
   - `framed`, optional and true unless given: `false` removes the pane body's border and background. The `image` kind uses this so the image stands directly below the tabs.
   - `Watcher`, optional, opens the kind's tabs by itself: see [A tab that opens by itself](#a-tab-that-opens-by-itself).
   - `closable`, optional and true unless given: `false` for a kind whose tab stands for as long as its session is listed. Its tab has no ×, neither Delete nor the middle click closes it, and `closeTab` leaves it where it is; it goes with its session alone. The `agents` kind is one (M106, C2).
   The `image` kind (M23) is the smallest example: its reference is an image's hash, or an image file's real path, its view state the display name, size and place it was opened with, and its body draws the image from `app://media` at fit or at its actual size, its tab scrolling then — [`artifacts/image/`](../src/renderer/src/artifacts/image/).
3. **Add one line** to [`kinds.ts`](../src/renderer/src/artifacts/kinds.ts), the list of built-ins. It is the only file of the pane's folder that names a kind, and `tests/architecture/artifact-kinds.test.ts` holds it so.
4. **Open a tab** with `openTab(sessionId, 'plan', reference)` from [`tabs-store.ts`](../src/renderer/src/artifacts/tabs-store.ts). A reference to a file or an external address goes through the page's one opener instead, `openReference` in [`opener.ts`](../src/renderer/src/artifacts/opener.ts). Where other parts of the page open your kind's tabs, give the opener a function for it and the kind's id, as `openAgent` and `AGENTS_KIND` are there for the chat's worker rows, a thread's own and an aside's source — it opens the Sub-agents tab with a sub-agent chosen in its view state — and `openAside` and `ASIDE_KIND` for the chat's Explain this, its markers and its toolbar: nothing outside the pane's folder imports a kind's module. A tab may be opened for something that does not exist yet: a new side question's tab is opened under an id the page makes, before anything is sent, and its body treats main's "unknown" as new.

## A tab that opens by itself

Most tabs open at a press. A kind whose tab should open when something happens — the `agents` kind's, as soon as a session lists a sub-agent — gives a `Watcher`: a component that draws nothing, which the session window draws once while the page runs, whatever the pane shows. It reads the app state and calls `openTab` when there is something new to see.

- **It opens with `{ select: false }`**, so the tab the user is reading stays shown: the new tab takes the view only where the session shows none. The exception is what the user is waiting for: the `plan` watcher opens a plan's tab selected when the plan arrives, when its next version does and when it is brought into the chat, since the decision it asks for is about that text. `{ first: true }` puts it before the others, for a tab that belongs to the session rather than to one thing in it.
- **It may open what is already open.** `openTab` on an open tab, given no view state and nothing handed, with `{ select: false }`, changes nothing — not even the store's objects — so a watcher of a tab that cannot be closed, as the `agents` one, simply opens it at each change of what it reads, and keeps nothing. A watcher of a tab the user may close and that should stay closed until something new comes keeps, for the run, what it has seen, and opens again only for something it has not. It never closes a tab itself.
- **The kinds are registered first.** They are registered in a layout effect, before any watcher's passive effect, so the first open succeeds; if it did not, the next change tries again.
- **It lives as long as the page.** What it keeps goes with a session no longer listed.

## What a body gets, and what it may do

```ts
interface TabBodyProps<R, V> {
  readonly sessionId: string;
  readonly reference: R;
  readonly viewState: V | null;
  readonly setViewState: (next: V) => void;
  readonly setTitle: (title: string) => void;
}
```

- **Only the selected tab's body is drawn.** Your body is mounted each time its tab is shown and unmounted when another is. What it holds in its own state is gone then.
- **The view state is what the pane keeps for you** between showings: something small, such as a file's line and where its text was scrolled to. Keep no content a tab reads in it. The `file` kind reads its file again at each showing. What the user is typing is theirs, and is the exception: the `aside` kind keeps its follow-up's draft there, so it is still in the field when the tab is shown again, and goes with the tab when it is closed.
- **A body is not a still view.** It may change its title with `setTitle`, change what it shows while it is shown, and hold an input of its own. The `agents` kind changes what it shows: its stack follows the app state, and an unfolded thread follows the session's pushes that name its sub-agent for as long as it is shown. The `aside` kind does all three: its answer is written into it by the pushes that name its aside, or arrives whole while a line of its own counts the wait, and its field takes a follow-up — Enter sends, Shift+Enter breaks the line, and the button is Stop while its turn runs.
- **An input asks for the focus only when its opener says so.** Opening a tab moves neither the focus nor the place of what was being read. Where an opening is the start of typing — a new side question — the opener puts a number in the tab's view state that changes at each such opening, and the body gives its field the focus once for each number it has not answered yet (`openAside(…, focus)` and `AsideBody`). A body never takes the focus because it was mounted.
- **A kind may handle explicit closing.** Supply `beforeClose(sessionId, reference)` when a close needs asynchronous cleanup; return `true` to close or `false` to keep the tab open after reporting a failure. The store ignores repeated closes while it waits. The `aside` kind removes its saved conversation through main, stopping a running answer, and keeps the tab on failure. This hook runs for X, middle click and Delete; it does not run when a session disappears or the app quits. Its watcher restores saved questions as tabs when their session is read.
- **What was already read for a tab** can be handed to it when it is opened, `openTab(…, { handed })`, and taken once with `takeHanded`. The `file` kind takes the answer that opened it, so an opening reads once; the `plan` kind takes the title its opener showed, so its tab is titled before its own read answers. The `agents` kind is handed nothing: what its opener chose — a sub-agent, and the label it showed — is put in its view state, merged over what the tab holds there.
- **A long text is read by ranges.** The `plan` kind asks main for a version at most 1 MiB at a time, with the whole length and hash, draws a version of up to 256 KiB whole and a longer one section by section, those near the view alone, and follows the push that streams a plan still being written.
- **A body holds nothing when it is not shown.** What a kind reads it reads again at its next showing, as the `file` kind reads its file and the `agents` kind an unfolded thread's items; it subscribes to a push only while it is mounted, and a part of a body that is folded away, as a thread is, is unmounted with what it held.

## Rules a kind follows

- **Text a provider or a file gave is drawn by [`MarkdownText`](../src/renderer/src/markdown/MarkdownText.tsx)**, or as plain text: elements and never HTML, no image loaded, no address of the text's own ([decision 0021](decisions/0021-drawing-conversation-text.md)). To make its references controls, provide an opener through `OpenerContext`, as the `file` kind does.
- **The page reads no file and resolves no path.** A kind asks main, and main checks ([decision 0022](decisions/0022-reading-project-files.md)).
- **Nothing a tab shows is stored by showing it**, logged or sent to the Pet. What a tab shows of a conversation is main's, in the conversation store; the tab reads it and keeps none of it.
- **Styles use the tokens**: no colour and no text size outside `tokens.css`, in both themes. The pane is a box of its own beside the chat's, about 437 px wide inside at the minimum window size and equal halves, and the gap between them lets the user narrow it to 300 px.
- **Scrolling and selection are pinned.** The pane itself never scrolls. If part of your body scrolls, or its text can be selected, add that rule to the lists in `tests/architecture/styles.test.ts`: the test names every part of the page that does either. A kind that draws with a component which already scrolls and selects adds none: the `agents` kind draws a sub-agent's items in the chat's own list ([`MessageList`](../src/renderer/src/chat/MessageList.tsx)), named and marked apart from the chat's, and its stylesheet's one scrolling part is its tab as a whole. The `aside` kind does the same for its conversation, draws its field by the chat's own input's rule, and cuts its quoted passage to a few lines without a scroll of its own; the one thing its stylesheet makes selectable, the passage, is on the list.
- **A conversation's items are drawn by the chat's components.** A kind that shows messages or what a session did uses `MessageList` and, through it, `ActivityGroup`, so a sub-agent's work reads as its session's does and takes the same keyboard; it gives them the session's opener through `OpenerContext`, and `WorkerOpenContext` where a row may choose a sub-agent.
- **What a selection may be asked about is a scope the drawer gives.** A message drawn under `AsideSourceContext` is marked as a source: Explain this stands beside its blocks, and its asides' passages are painted in it. The chat and a sub-agent's thread give that scope; the `aside` kind does not, so an aside's own answers offer no Explain this and carry no marker.
- **A kind imports the pane's own files and no other kind's**: `tab-kind.ts`, `tabs-store.ts`, `opener.ts` and the shared artifact bar and its styles.

## Checks

- `tests/architecture/artifact-kinds.test.ts`: the pane's own files name no kind, `kinds.ts` holds a line a kind, and nothing outside the pane's folder imports a kind's module.
- `src/renderer/src/artifacts/ArtifactPane.test.tsx` draws a kind defined outside the pane's folder, [`tests/support/example-kind.tsx`](../tests/support/example-kind.tsx): a kind that changes its title and body while shown and holds an input. It is the smallest complete kind to copy from.
- Your kind's own tests go beside its sources.
