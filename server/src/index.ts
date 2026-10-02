import { createApp } from './app.js'

const { app, store, config } = createApp()
const server = app.listen(config.port, config.listenHost, () => {
  console.log(`TenderLens India: http://127.0.0.1:${config.port}`)
  console.log(`Runtime: Node-only. Retrieval: ${config.retrievalMode}. Free-only Gemma gate: ${config.freeTierConfirmed ? 'confirmed by user' : 'not confirmed'}.`)
  console.log('No external model request is made until you ask a question with explicit consent.')
})
server.on('error', error => {
  console.error(`The local server could not start: ${error.name}. Check the configured port.`)
  store.close()
  process.exitCode = 1
})
let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  server.close(() => { store.close(); process.exit(0) })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
