import { describe, expect, test } from "bun:test";
import { createWorktreeDemo } from "./worktree-demo-server";
import { WorktreeDemoState, scenarios, validBranch, type Scenario } from "./worktree-demo-state";
import { DemoWorkspaceContext } from "./worktree-demo-context";

const creation = {mode:"new",branch:"feature/checkout",base:"main · a1b2c3d",parent:"/demo/workspaces",folder:"atlas-checkout",name:"Atlas · Checkout",authentication:"none",signing:"none"};

describe("isolated worktree adapter",()=>{
  test("layout navigation is read-only and independent main/child lifecycles retain parent policy", async () => {
    const demo = createWorktreeDemo(); demo.state.reset("mixed-lifecycle");
    const before = structuredClone(demo.state.rows);
    for (const path of ["/", "/?layout=running-shortcuts"]) {
      const html = await (await demo.fetch(new Request(`http://127.0.0.1${path}`))).text();
      expect(html).toContain("createDashboardGroups");
      expect(html).toContain("installDashboardScenarios");
      expect(html).not.toContain("Running shortcuts");
      expect(html).not.toContain("Demo layout");
      expect(demo.state.rows).toEqual(before);
    }
    const post = (id: string, action: string) => demo.fetch(new Request(`http://127.0.0.1/api/hub/sessions/${id}/${action}`, { method: "POST" }));
    const main = demo.state.rows[0]!, child = demo.state.rows[1]!;
    expect((await post(main.id, "start")).ok).toBe(true);
    expect((await post(main.id, "stop")).ok).toBe(true);
    expect(main.running).toBe(false); expect(child.running).toBe(true);
    await post(child.id, "stop");
    expect((await post(child.id, "start")).ok).toBe(true);
    expect(main.running).toBe(false); expect(child.running).toBe(true);
    expect(demo.state.effective(child).authentication).toBe(main.authentication);
    demo.state.reset("all-stopped"); expect(demo.state.rows.every(row => !row.running)).toBe(true);
    demo.close();
  });
  test("all creation modes return compact completion without starting; retained registration retry keeps identity", async () => {
    for (const prefix of ["/worktrees", "/hub-worktrees"]) for (const fields of [{ mode: "new", branch: "feature/compact" }, { mode: "existing", selection: "local:fix/navigation" }, { mode: "existing", selection: "remote:origin/feature/search" }]) {
      const demo = createWorktreeDemo();
      const result = await (await demo.fetch(new Request(`http://127.0.0.1${prefix}/create`, { method: "POST", body: new URLSearchParams(Object.entries(fields)) }))).json();
      expect(result.completion).toMatchObject({ id: "atlas-created-1", source: "atlas", message: `Created ${demo.state.rows.at(-1)!.branch}` });
      expect(demo.state.rows.at(-1)!.running).toBe(false);
      expect(demo.state.sourceSelection.workspace).toBe("atlas");
      demo.close();
    }
    const demo = createWorktreeDemo(); demo.state.reset("registration-failure");
    const post = async (action: string, fields: Record<string, string>) => (await demo.fetch(new Request(`http://127.0.0.1/worktrees/${action}`, { method: "POST", body: new URLSearchParams(fields) }))).json();
    expect((await post("create", { mode: "new", branch: "feature/retained" })).completion).toBeUndefined();
    const retained = demo.state.rows.at(-1)!;
    expect(demo.state.message).not.toContain(retained.path);
    expect(demo.state.message).not.toContain(retained.checkout);
    expect((await post("register", { id: retained.id })).completion.message).toBe("Created feature/retained");
    expect(demo.state.rows.at(-1)).toBe(retained); expect(demo.state.rows).toHaveLength(6);
    demo.close();
  });

  test("compact presentation never bypasses deletion rechecks or offers metadata/checkbox confirmation", async () => {
    const { worktreePage } = await import("../../src/hub/worktree-pages");
    const state = new WorktreeDemoState();
    for (const running of [false, true]) {
      state.reset("populated"); state.rows[1]!.running = running;
      const content = worktreePage(state.presentation("delete", "atlas-sidebar"), "SIMULATION", "", true);
      expect(content).toContain("Delete worktree?"); expect(content).toContain("Atlas / feature/sidebar");
      expect(content).toContain(running ? ">Stop and delete</button>" : ">Delete</button>");
      expect(content).not.toContain("<dl"); expect(content).not.toContain('type="checkbox"');
      expect(content).not.toContain("/demo/"); expect(content).not.toContain("SIMULATION");
      state.mutate("delete", { id: "atlas-sidebar" }); expect(state.rows).toHaveLength(5);
      state.mutate("delete", { id: "atlas-sidebar", confirm: "1" }); expect(state.rows).toHaveLength(4);
      expect(state.branches).toContain("feature/sidebar");
    }
    for (const scenario of ["dirty", "untracked", "ignored", "locked", "in-use", "nested", "stop-failure"] as const) {
      state.reset(scenario);
      state.mutate("delete", { id: "atlas-sidebar", confirm: "1" });
      expect(state.rows).toHaveLength(5);
      const content = worktreePage(state.presentation("delete", "atlas-sidebar"), "SIMULATION", "", true);
      expect(content).toContain('role="alert"'); expect(content).not.toContain('action="/worktrees/delete"');
      expect(content).toContain("Cancel"); expect(content).not.toContain("<dl");
    }
  });
  test("creation source snapshots are truthful, repository-scoped and independent of live policy/upstream", async () => {
    const demo = createWorktreeDemo();
    const state = demo.state;
    const parent = state.rows.find(row => row.id === "beacon")!;
    parent.branch = "release";
    state.mutate("create", { source: parent.id, mode: "new", branch: "feature/provenance", base: "invented", sourceRef: "invented" });
    const child = state.rows.at(-1)!;
    expect(child).toMatchObject({ sourceRef: "release", base: "release" });
    parent.branch = "fix/navigation";
    state.mutate("settings", { id: parent.id, configuration: "default", authentication: "demo-auth" });
    expect(state.effective(child)).toMatchObject({ sourceRef: "release", base: "release", authentication: "demo-auth" });
    state.mutate("create", { source: "atlas", mode: "existing", selection: "remote:origin/feature/search" });
    const remote = state.rows.at(-1)!;
    expect(remote).toMatchObject({ sourceRef: "origin/feature/search", upstream: "origin/feature/search" });
    remote.upstream = "upstream/feature/search";
    expect(state.effective(remote).sourceRef).toBe("origin/feature/search");
    state.mutate("create", { source: "atlas", mode: "existing", selection: "local:fix/navigation", sourceRef: "main" });
    expect(state.rows.at(-1)!.sourceRef).toBeUndefined();
    expect(state.rows.at(-1)!.base).toBe("fix/navigation");
    state.discover();
    const external = state.rows.at(-1)!;
    external.upstream = "origin/main";
    state.mutate("register", { id: external.id });
    expect(state.effective(external).sourceRef).toBeUndefined();
    // Creating another checkout of a branch does not create that branch anew.
    state.mutate("delete", { id: child.id, confirm: "1" });
    state.mutate("create", { source: "beacon", mode: "existing", selection: "local:feature/provenance" });
    expect(state.rows.at(-1)!.sourceRef).toBe("release");
    state.mutate("create", { source: "atlas", mode: "new", branch: "feature/provenance" });
    expect(state.rows.at(-1)!.sourceRef).toBe("main");
    const payload = await (await demo.fetch(new Request("http://127.0.0.1/api/hub/state"))).json();
    expect(payload.workspaces.find((row: { id: string }) => row.id === remote.id).sourceRef).toBe("origin/feature/search");
    expect(payload.workspaces.find((row: { id: string }) => row.id === external.id).sourceRef).toBeUndefined();
  });

  test("recorded branch origin survives forget, retry and checkout deletion", () => {
    const state = new WorktreeDemoState();
    state.reset("registration-failure");
    state.mutate("create", { mode: "new", branch: "feature/recorded" });
    const child = state.rows.at(-1)!;
    state.rows[0]!.branch = "release";
    state.mutate("register", { id: child.id });
    state.mutate("forget", { id: child.id, confirm: "1" });
    state.mutate("register", { id: child.id });
    expect(child.sourceRef).toBe("main");
    state.mutate("delete", { id: child.id, confirm: "1", deleteBranch: "1", confirmBranch: "1" });
    state.scenario = "populated";
    state.mutate("create", { mode: "existing", selection: "local:feature/recorded" });
    expect(state.rows.at(-1)!.sourceRef).toBe("main");
  });

  test("compact creation fixes source HEAD and combines all local and remote refs without silent reset", () => {
    const state = new WorktreeDemoState();
    const refs = state.presentation("create").refs;
    expect(refs.local.map(([ref]) => ref)).toEqual(expect.arrayContaining(["main", "feature/sidebar", "fix/navigation", "review/accessibility", "release"]));
    expect(refs.remote.map(([ref]) => ref)).toEqual(["origin/feature/search", "origin/release", "upstream/release"]);
    state.mutate("create", { source: "beacon", mode: "new", branch: "feature/minimal", base: "ignored choice" });
    expect(state.rows.at(-1)).toMatchObject({ parentId: "beacon", branch: "feature/minimal", base: "main", sourceRef: "main", running: false });
    state.mutate("create", { source: "atlas", mode: "existing", selection: "remote:origin/feature/search" });
    expect(state.rows.at(-1)).toMatchObject({ branch: "feature/search", upstream: "origin/feature/search", running: false });
    const count = state.rows.length;
    state.mutate("create", { source: "atlas", mode: "existing", selection: "remote:upstream/release" });
    expect(state.error).toBe(true); expect(state.rows).toHaveLength(count);
    state.mutate("create", { source: "atlas", mode: "existing", selection: "local:main" });
    expect(state.conflictId).toBe("atlas"); expect(state.rows).toHaveLength(count);
    state.mutate("create", { source: "atlas", mode: "existing", selection: "remote:invented/ref" });
    expect(state.error).toBe(true); expect(state.rows).toHaveLength(count);
  });
  test("repository-scoped exact names, fixed safe paths and deterministic collision handling", () => {
    const state = new WorktreeDemoState();
    state.mutate("create", { ...creation, branch: "feature/login", source: "atlas" });
    expect(state.rows.at(-1)).toMatchObject({ name: "feature/login", parentId: "atlas", path: "/demo/workspaces/atlas.worktrees/feature-login" });
    state.mutate("create", { ...creation, branch: "feature/login", source: "beacon" });
    expect(state.rows.at(-1)).toMatchObject({ name: "feature/login", parentId: "beacon", path: "/demo/workspaces/beacon.worktrees/feature-login" });
    state.mutate("create", { ...creation, branch: "feature-login", source: "atlas" });
    const collisionPath = state.rows.at(-1)!.path;
    expect(collisionPath).toMatch(/atlas.worktrees\/feature-login-[a-f0-9]{8}$/);
    state.reset("populated");
    for (const branch of ["feature/login", "feature-login"]) state.mutate("create", { ...creation, branch });
    expect(state.rows.at(-1)!.path).toBe(collisionPath);
    const length = state.rows.length;
    state.mutate("create", { ...creation, source: "atlas-sidebar", branch: "child/cannot-fork" });
    expect(state.error).toBe(true); expect(state.rows).toHaveLength(length);
  });
  test.each(["--bad", "a//b", "a/.hidden", "a.lock/b", "a@{b", "a..b", "a.", "@", "a\\b", "a\u007fb"])("invalid local branch %s is refused", branch => expect(validBranch(branch)).toBe(false));
  test("parent policy is a live reference, never a child override or runtime copy", () => {
    const state = new WorktreeDemoState();
    state.mutate("create", creation);
    const child = state.rows.at(-1)!;
    expect(child.authentication).toBeUndefined();
    state.mutate("settings", { id: "atlas", authentication: "none", signing: "demo-signing", configuration: "review" });
    expect(state.effective(child)).toMatchObject({ authentication: "none", signing: "demo-signing", configuration: "review", running: false });
    state.mutate("settings", { id: child.id, authentication: "demo-auth" });
    expect(state.error).toBe(true);
    expect(state.effective(child).authentication).toBe("none");
    state.discover(); const external = state.rows.at(-1)!; const path = external.path;
    state.mutate("register", { id: external.id, name: "ignored", authentication: "demo-auth" });
    expect(state.effective(external)).toMatchObject({ name: "agent/exploration", path, ownership: "external", authentication: "none" });
  });
  test("explicit HTTPS origin permits only its matching reverse-proxy authority",async()=>{
    const origin="https://demo.example.test:8446";
    const demo=createWorktreeDemo({publicOrigin:origin});
    const backend="http://demo.example.test:8446";
    expect((await demo.fetch(new Request(`${backend}/worktrees`,{headers:{host:"demo.example.test:8446"}})))!.status).toBe(302);
    expect((await demo.fetch(new Request(`${backend}/worktrees`))).headers.get("location")).toBe(`${origin}/s/atlas/`);
    expect((await demo.fetch(new Request(`${backend}/__demo/reset`,{method:"POST",headers:{origin},body:new URLSearchParams({scenario:"populated",latency:"0"})}))).status).toBe(200);
    for(const rejectedOrigin of ["https://evil.example.test",backend,"null","https://demo.example.test","https://demo.example.test:8446.evil.test"]) {
      expect((await demo.fetch(new Request(`${backend}/__demo/discover`,{method:"POST",headers:{origin:rejectedOrigin}}))).status).toBe(403);
    }
    for(const url of ["http://evil.example.test","http://demo.example.test:8447","http://127.0.0.1:4788"]) {
      expect((await demo.fetch(new Request(`${url}/__demo/discover`,{method:"POST",headers:{origin,"x-forwarded-host":"demo.example.test:8446","x-forwarded-proto":"https",forwarded:'host="demo.example.test:8446";proto=https'}}))).status).toBe(403);
    }
    expect((await demo.fetch(new Request(`${backend}/worktrees`,{headers:{host:"evil.example.test"}}))).status).toBe(403);
    expect((await demo.fetch(new Request("http://127.0.0.1/worktrees",{headers:{host:"demo.example.test:8446"}}))).status).toBe(403);
    expect((await createWorktreeDemo().fetch(new Request(`${backend}/worktrees`,{headers:{"x-forwarded-host":"localhost"}}))).status).toBe(403);
    expect((await demo.fetch(new Request("http://127.0.0.1/__demo/discover",{method:"POST",headers:{origin:"http://127.0.0.1"}}))).status).toBe(200);
  });
  test.each(["http://demo.example.test","https://demo.example.test/","https://demo.example.test/path","https://user:secret@demo.example.test","https://demo.example.test?query","https://demo.example.test#fragment",""])("rejects non-origin configuration %s",publicOrigin=>{
    expect(()=>createWorktreeDemo({publicOrigin})).toThrow();
  });
  test("closed route/method allowlist and same-origin guard",async()=>{
    const demo=createWorktreeDemo();
    for(const path of ["/api/workspaces/start","/api/hub/credentials","/logout","/worktrees/force","/s/atlas/api/terminal","/../../etc/passwd"]) {
      const response=await demo.fetch(new Request(`http://127.0.0.1${path}`,{method:"POST"})); expect([404,405]).toContain(response!.status);
    }
    expect((await demo.fetch(new Request("http://127.0.0.1/worktrees/create",{method:"DELETE"}))).status).toBe(405);
    expect((await demo.fetch(new Request("http://127.0.0.1/worktrees/create",{method:"POST",headers:{origin:"https://other.invalid"}}))).status).toBe(403);
    expect((await demo.fetch(new Request("http://public.invalid/"))).status).toBe(403);
    expect(demo.state.rows).toHaveLength(5); expect(demo.state.rows[1]!.running).toBe(false);
  });
  test("presentation import graph cannot reach operations or process/persistence APIs",async()=>{
    const visited=new Set<string>();
    async function inspect(path:string) {
      if(visited.has(path)) return; visited.add(path);
      const text=await Bun.file(path).text();
      expect(text).not.toMatch(/Bun\.(spawn|write)|node:(child_process|fs)|from ["'][^"']*(credential-store|provider-runtime|hub\/server|backend|registry|sessions)["']/);
      for(const match of text.matchAll(/(?:import|export)\s+(?!type\b)[\s\S]*?from\s+["'](\.[^"']+)["']/g)) {
        const child=new URL(`${match[1]}.ts`, `file://${path}`).pathname;
        if(await Bun.file(child).exists()) await inspect(child);
      }
    }
    await inspect(new URL("./worktree-demo-server.ts",import.meta.url).pathname);
    expect([...visited].some(path=>path.endsWith("pages.ts"))).toBe(true);
  });
  test("reset cancels pending mutations and restores checkout identity counter",async()=>{
    const demo=createWorktreeDemo();demo.state.latency=40;
    const body=new FormData();for(const [key,value] of Object.entries(creation)) body.set(key,value);
    const pending=demo.fetch(new Request("http://127.0.0.1/worktrees/create",{method:"POST",body}));
    await Bun.sleep(10);demo.state.reset("populated");
    expect((await pending).status).toBe(409);expect(demo.state.rows).toHaveLength(5);expect(demo.state.sequence).toBe(0);
  });
  test("separate contexts, attachments and file restoration remain wholly in memory", async () => {
    const source = new DemoWorkspaceContext("atlas", "Atlas", 1);
    const other = new DemoWorkspaceContext("atlas-sidebar", "Sidebar", 1);
    await source.chat.restoreFixture("NOTES.md", "# In-memory restoration");
    expect(source.files.get("NOTES.md")).toBe("# In-memory restoration");
    expect(other.files.get("NOTES.md")).not.toBe(source.files.get("NOTES.md"));
    await expect(source.chat.restoreFixture("../../outside", "refused")).rejects.toThrow();
    const bytes = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
    const image = await source.chat.saveAttachment(bytes);
    expect(source.attachments.get(image.id)?.bytes).toEqual(bytes);
    expect(other.attachments.has(image.id)).toBe(false);
    await expect(other.chat.history((await source.chat.listConversations())[0]!.id)).rejects.toThrow();
    source.dispose(); other.dispose();
    expect(source.attachments.size).toBe(0);
    expect(await source.chat.listConversations()).toEqual([]);
  });
  test("no supplied authentication secret can be retained, and reset clears all context stores", async () => {
    const demo = createWorktreeDemo();
    const request = (path: string, init?: RequestInit) => demo.fetch(new Request(`http://127.0.0.1${path}`, init));
    const rejected = await request("/worktrees/create", { method: "POST", body: new URLSearchParams({ ...creation, authentication: "not-a-synthetic-selection" }) });
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(demo.state)).not.toContain("not-a-synthetic-selection");
    await request("/s/atlas/api/state");
    await request("/s/atlas/api/personal-state", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ documentPath: "NOTES.md" }) });
    const oldContext = demo.contexts.get("atlas")!;
    const oldGeneration = demo.state.generation;
    await request("/__demo/reset", { method: "POST", body: new URLSearchParams({ scenario: "populated" }) });
    expect(demo.contexts.size).toBe(0);
    expect(await oldContext.chat.listConversations()).toEqual([]);
    expect((await request("/s/atlas/api/personal-state", { method: "PATCH", headers: { "x-demo-generation": String(oldGeneration), "content-type": "application/json" }, body: JSON.stringify({ documentPath: "NOTES.md" }) })).status).toBe(409);
    expect(await (await request("/s/atlas/api/personal-state")).json()).not.toHaveProperty("documentPath");
    expect((await request(`/s/atlas/NOTES.md?demoGeneration=${oldGeneration}`, { headers: { accept: "text/html" } })).status).toBe(302);
    demo.close();
  });
  test("all scenarios reset mutations and use synthetic data without secrets",()=>{
    const state=new WorktreeDemoState();
    for(const scenario of Object.keys(scenarios) as Scenario[]) {
      state.reset("populated"); state.mutate("create",creation);state.mutate("start",{id:"atlas-created-1"});
      state.mutate("delete",{id:"atlas-created-1",confirm:"on"}); state.discover();
      state.reset(scenario,1200);
      expect(state.sequence).toBe(0);expect(state.ledger).toEqual([]);expect(state.rows.some(row=>row.id==="atlas-created-1")).toBe(false);
      expect(state.sourceSelection).toEqual({workspace:"atlas",conversation:"source-conversation"});
      expect(JSON.stringify(state)).not.toMatch(/password|privateKey|accessToken/);
    }
  });
  test.each(["new","local","remote"])("explicit %s creation and stopped default",mode=>{
    const state=new WorktreeDemoState(); state.mutate("create",{...creation,mode,local:"fix/navigation",remote:"origin/feature/search",cached:"on"});
    const row=state.rows.at(-1)!;expect(row.id).toBe("atlas-created-1");expect(row.running).toBe(false);expect(state.effective(row).authentication).toBe("demo-auth");
    expect(row.branch).toBe(mode==="local"?"fix/navigation":"feature/checkout");
    expect(row.upstream).toBe(mode==="remote"?"origin/feature/search":undefined);
  });
  test("retained checkout retry, failed start, discovery and forget preserve identity",()=>{
    const state=new WorktreeDemoState(); state.reset("registration-failure");state.mutate("create",creation);
    const row=state.rows.at(-1)!;const identity=row.checkout;expect(row.registered).toBe(false);
    state.mutate("register",{id:row.id,name:row.name});state.mutate("register",{id:row.id,name:row.name});
    expect(state.rows).toHaveLength(6);expect(row.checkout).toBe(identity);
    state.scenario="start-failure";state.mutate("start",{id:row.id});expect(row.running).toBe(false);expect(row.registered).toBe(true);
    state.discover();state.discover();expect(state.rows).toHaveLength(7);
    state.mutate("forget",{id:row.id,confirm:"on"});expect(row.registered).toBe(false);expect(row.checkout).toBe(identity);expect(state.branches).toContain(row.branch);
  });
  test.each(["dirty","untracked","ignored","locked","in-use","nested","stop-failure"] as Scenario[])("%s delete retains registration and checkout",scenario=>{
    const state=new WorktreeDemoState();state.reset(scenario);state.mutate("delete",{id:"atlas-sidebar",confirm:"on"});
    expect(state.error).toBe(true);expect(state.rows[1]!.registered).toBe(true);expect(state.rows[1]!.checkout).toBe("checkout-sidebar");
  });
  test("external/main/missing identity never acquires destructive ownership",()=>{
    const state=new WorktreeDemoState();
    for(const id of ["atlas","atlas-review"]) {state.mutate("delete",{id,confirm:"on"});expect(state.error).toBe(true);}
    state.rows[1]!.availability="replaced";state.mutate("delete",{id:"atlas-sidebar",confirm:"on"});expect(state.rows).toHaveLength(5);
  });
  test("checkout deletion always preserves branches, even with obsolete branch fields",()=>{
    const state=new WorktreeDemoState();
    state.mutate("delete",{id:"atlas-sidebar",confirm:"on",deleteBranch:"on",confirmBranch:"on"});expect(state.rows).toHaveLength(4);expect(state.branches).toContain("feature/sidebar");expect(state.message).toContain("preserved");
  });
  test("explicit fetch preserves query and valid choice, invalidates disappeared ref, and retains cached refs on error",()=>{
    const state = new WorktreeDemoState();
    const draft = { source:"beacon", mode:"existing", query:"origin/feature/search", selection:"remote:origin/feature/search" };
    expect(state.mutate("fetch", draft)).toContain("view=create&source=beacon");
    expect(state.draft).toMatchObject(draft);
    expect(state.repositoryRemoteRefs.get("repository-beacon")).toContain("origin/fetched");
    expect(state.repositoryRemoteRefs.get("repository-atlas")).not.toContain("origin/fetched");
    for (const scenario of ["fetch-auth", "fetch-network"] as const) {
      state.reset(scenario); state.mutate("fetch", draft);
      expect(state.error).toBe(true); expect(state.fresh).toBe(false);
      expect(state.draft).toMatchObject(draft); expect(state.repositoryRemoteRefs.get("repository-beacon")).not.toContain("origin/fetched");
    }
    state.reset("fetch-disappearance"); state.mutate("fetch", draft);
    expect(state.draft.query).toBe(draft.query); expect(state.draft.selection).toBe("");
    state.mutate("create", draft); expect(state.rows).toHaveLength(5);
  });
});
