# Development

## Build and Package

The editable extension sources live in `src/` as TypeScript. Helper scripts in `scripts/` are also TypeScript and run through `tsx`.

Type-check the TypeScript sources without emitting files:

```powershell
npm run typecheck
```

Bundle `src/extension.ts` and runtime dependencies into `dist/extension.ts`:

```powershell
npm run bundle
```

Create an installable VSIX package with:

```powershell
npm run package:vsix
```

That command rebuilds the bundle, checks the generated bundle, then calls `vsce package`. The generated `.vsix` can be installed locally from VS Code with `Extensions: Install from VSIX...`, or from the command line:

```powershell
code --install-extension .\pandoc-manuscript-tools-0.0.1.vsix
```

## Publish to VS Code Marketplace

Marketplace publishing uses Microsoft's `vsce` CLI. Before publishing, replace `"publisher": "local"` in `package.json` with your real Marketplace publisher ID.

1. Create or open a publisher at <https://marketplace.visualstudio.com/manage/publishers/>.
2. Create an Azure DevOps Personal Access Token that can publish Marketplace extensions.
3. Log in locally:

   ```powershell
   npx vsce login <publisher-id>
   ```

4. Publish the current version:

   ```powershell
   npm run publish:marketplace
   ```

For quick patch releases, update the Marketplace package with:

```powershell
npm run publish:patch
```

`vsce publish patch` increments the patch version and publishes in one step, so use it only after the current working tree is ready to release.

Before a public release, also add a repository URL so the Marketplace listing does not show a packaging warning.

