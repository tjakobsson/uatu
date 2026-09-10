// @ts-expect-error TypeScript resolves TS modules before considering Bun's text loader.
import source from "../shell/navigation-preferences.ts" with { type: "text" };

// Embed the production owner, not a second storage implementation. A text
// import survives single-binary builds; transpilation here also avoids closure
// names from Function#toString being changed by the release minifier.
export const navigationPreferencesClientSource = new Bun.Transpiler({ loader: "ts" }).transformSync(
  source.replace(/^import \{ appBasePath \} from "\.\.\/shared\/app-url";$/m, 'const appBasePath = () => "/";')
    .replace(/^export /gm, ""),
) + "\nconfirmNavigationHubScope();";
