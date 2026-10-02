# TenderLens workspace

React 19 + TypeScript + Vite. The application uses the Clawpilot theme variables,
Segoe UI typography, Lucide icons and no external font or analytics requests.

See the [root README](../README.md) for full setup, model/privacy configuration,
Indian sample data and deployment limitations.

```powershell
npm ci
npm run dev
```

The dev server binds to `127.0.0.1:5173` and proxies `/api` to the Node backend
at port 8000 (`npm run dev:api` from the repository root). Run `npm run build` for production assets and `npm run test:e2e`
for browser flows. `MOCK_API=1` runs UI contract fixtures only, not real backend
or model validation.
