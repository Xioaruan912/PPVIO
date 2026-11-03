import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useBackLayer, useRouteState } from "./navigation";
let box: HTMLDivElement, root: Root;
function App() {
  const [page, go, , back] = useRouteState("feed");
  useBackLayer(page === "menu", () => go("player", true));
  return <><span>{page}</span><button onClick={() => go("player")}>open</button><button onClick={() => go("library")}>tab</button><button onClick={back}>back</button></>;
}
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); history.replaceState({}, ""); box = document.createElement("div"); document.body.append(box); root = createRoot(box); });
afterEach(async () => { await act(async () => root.unmount()); box.remove(); });
const click = (text: string) => act(() => { [...box.querySelectorAll("button")].find(b => b.textContent === text)!.click(); });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
it("maps browser back/forward to the original app entries and replacement keeps the entry", async () => {
  await act(async () => root.render(<App />)); click("open"); expect(box.querySelector("span")?.textContent).toBe("player");
  click("tab"); expect(box.querySelector("span")?.textContent).toBe("library");
  click("back"); await settle(); expect(box.querySelector("span")?.textContent).toBe("player");
  history.back(); await settle(); expect(box.querySelector("span")?.textContent).toBe("feed");
  history.forward(); await settle(); expect(box.querySelector("span")?.textContent).toBe("player");
});
it("closes a visible sheet before the route below it", async () => {
  function Layer() {
    const [open, go] = useRouteState(false);
    useBackLayer(open, () => go(false, true));
    return <button onClick={() => go(true, true)}>{open ? "menu" : "closed"}</button>;
  }
  await act(async () => root.render(<Layer />)); act(() => box.querySelector("button")!.click());
  await settle(); expect(box.textContent).toBe("menu"); history.back(); await settle(); expect(box.textContent).toBe("closed");
});

it("navigating from a preview consumes its layer so one back returns to the list", async () => {
  function FromPreview() {
    const [page, go, , back] = useRouteState("list");
    const [open, setOpen] = useState(false);
    useBackLayer(open, () => setOpen(false));
    return <><span>{page}</span><button onClick={() => setOpen(true)}>preview</button><button onClick={() => { setOpen(false); go("player"); }}>play</button><button onClick={back}>back</button></>;
  }
  await act(async () => root.render(<FromPreview />)); click("preview"); await settle();
  click("play"); await settle(); click("back"); await settle(); expect(box.querySelector("span")?.textContent).toBe("list");
  expect(history.state.ppvioLayer).toBeUndefined();
});
