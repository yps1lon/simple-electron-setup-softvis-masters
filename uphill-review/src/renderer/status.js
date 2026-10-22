// The status line is the app's one channel of feedback, so every failure
// ends up here rather than in a console nobody has open.

export function setStatus(text) {
  document.getElementById("status").textContent = text;
}

// Engine failures arrive as rejected IPC promises carrying the engine's
// error message; show it instead of failing silently.
export async function guard(fn) {
  try {
    await fn();
  } catch (error) {
    setStatus(`error: ${error.message}`);
  }
}
