bring cloud;
bring util;

let counter = new cloud.Counter();
pub class Example {
  pub inflight getMessage(): str {
    return "message";
  }
  pub inflight done() {
    counter.inc();
  }
}
let example = new Example();
let queue = new cloud.Queue();
queue.setConsumer(@inflight("./inline_typescript.ts", 
  lifts: { example: { lift: example, ops: ["getMessage", "done"] } }
));

test "x" {
  queue.push("message");
  util.waitUntil(inflight () => {
    return counter.peek() > 0;
  });
}