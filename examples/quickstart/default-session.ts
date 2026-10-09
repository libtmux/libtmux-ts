import { Server, ownSession } from "libtmux";

const server = new Server();
await using owned = await ownSession(server, { name: `example-${crypto.randomUUID()}` });
const session = owned.value;

console.log(JSON.stringify({ id: session.id, name: session.name, socketPath: server.socketPath }));
