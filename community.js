let connection = null;
let sessionController = null;
let refreshInterval = null;
let currentFriend = null;
let friends = [];
let history = [];
let messageSignature = "";
let conversationVersion = 0;
let refreshing = false;
let sending = false;

function element(id) {
  return document.getElementById(id);
}

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function status(id, message = "", error = false) {
  element(id).textContent = message;
  element(id).classList.toggle("status-error", error);
}

function dateLabel(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
}

function sizeLabel(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

async function api(action, options = {}, parameters = {}) {
  if (!connection?.getUser() || !sessionController || sessionController.signal.aborted) throw new Error("Please sign in to continue.");
  const controller = sessionController;
  const token = await connection.getToken();
  const query = new URLSearchParams({ action, ...parameters });
  const response = await fetch(`/api/community?${query}`, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "Unable to connect to StudyHub. Please try again.");
  }
  return action === "file" ? response : response.json();
}

function jsonOptions(method, body) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function startCommunity(options) {
  stopCommunity();
  connection = options;
  sessionController = new AbortController();
  refreshNotifications();
  if (element("notes").classList.contains("active")) refreshPosts();
  refreshInterval = setInterval(refreshCommunity, 8000);
}

export function stopCommunity() {
  sessionController?.abort();
  clearInterval(refreshInterval);
  refreshInterval = null;
  connection = null;
  sessionController = null;
  friends = [];
  refreshing = false;
  closeConversation();
  element("notificationBadge").classList.add("hidden");
  element("notificationsList").replaceChildren(node("div", "empty", "No notifications yet."));
  element("postsList").replaceChildren(node("div", "empty", "Sign in to view community posts."));
  element("postForm").reset();
  ["chatStatus", "notificationStatus", "postStatus", "postsStatus"].forEach(id => status(id));
}

export function updateChatFriends(updatedFriends) {
  friends = updatedFriends;
  if (currentFriend && !friends.some(friend => friend.uid === currentFriend)) closeConversation();
  renderFriends();
}

function renderFriends() {
  const list = element("chatFriends");
  list.replaceChildren();
  if (!friends.length) {
    list.append(node("div", "empty", "No friends yet. Visit Friends to find a classmate."));
    return;
  }
  for (const friend of friends) {
    const button = node("button", `conversation-link${friend.uid === currentFriend ? " selected" : ""}`);
    button.type = "button";
    button.setAttribute("aria-pressed", String(friend.uid === currentFriend));
    const details = node("span", "conversation-details");
    details.append(node("strong", "", friend.name), node("small", "", "Message or share a file"));
    button.append(node("span", "avatar", friend.name.charAt(0).toUpperCase()), details);
    button.onclick = () => openConversation(friend.uid);
    list.append(button);
  }
}

export async function openConversation(friendUid) {
  if (!connection?.getUser()) return;
  const version = ++conversationVersion;
  currentFriend = friendUid;
  history = [];
  messageSignature = "";
  element("messageInput").value = "";
  clearChatFile();
  element("chatName").textContent = friends.find(friend => friend.uid === friendUid)?.name || "Friend";
  element("chatWelcome").classList.add("hidden");
  element("chatBox").classList.remove("hidden");
  element("messages").replaceChildren(node("div", "empty", "Loading your conversation..."));
  status("chatStatus");
  renderFriends();
  const legacy = connection.legacyMessages(friendUid).catch(() => {
    if (version === conversationVersion) status("chatStatus", "Older messages could not load. You can still send new messages.", true);
    return [];
  });
  try {
    const messages = await api("messages", {}, { friend: friendUid });
    const olderMessages = await legacy;
    if (version !== conversationVersion || !connection) return;
    history = olderMessages;
    renderMessages(messages);
    await markConversationRead(friendUid, messages);
    if (version === conversationVersion) element("messageInput").focus();
  } catch (error) {
    if (version !== conversationVersion || !connection) return;
    element("messages").replaceChildren(node("div", "empty", "Your conversation could not load. Select this friend again to retry."));
    status("chatStatus", error.message, true);
  }
}

export function closeConversation() {
  conversationVersion++;
  currentFriend = null;
  history = [];
  messageSignature = "";
  element("chatBox").classList.add("hidden");
  element("chatWelcome").classList.remove("hidden");
  element("messages").replaceChildren();
  element("messageInput").value = "";
  clearChatFile();
  renderFriends();
}

function renderMessages(messages) {
  const signature = messages.map(message => message.id).join("|");
  if (signature === messageSignature && element("messages").dataset.rendered === String(conversationVersion)) return;
  messageSignature = signature;
  const list = element("messages");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
  const initialRender = list.dataset.rendered !== String(conversationVersion);
  list.dataset.rendered = String(conversationVersion);
  list.replaceChildren();
  const combined = [...history, ...messages].sort((first, second) => (Date.parse(first.createdAt) || 0) - (Date.parse(second.createdAt) || 0));
  if (!combined.length) list.append(node("div", "empty", "Say hello or share your first study file."));
  for (const message of combined) {
    const bubble = node("div", `message ${message.senderUid === connection.getUser().uid ? "mine" : "theirs"}`);
    if (message.text) bubble.append(node("div", "message-text", message.text));
    if (message.fileName) {
      const button = node("button", "file-download", `Download ${message.fileName}`);
      button.type = "button";
      button.onclick = () => downloadFile(message.id, message.fileName, button);
      bubble.append(button, node("small", "file-size", sizeLabel(message.fileSize)));
    }
    bubble.append(node("time", "message-time", dateLabel(message.createdAt)));
    list.append(bubble);
  }
  if (initialRender || nearBottom) list.scrollTop = list.scrollHeight;
}

async function refreshMessages() {
  const friendUid = currentFriend;
  const version = conversationVersion;
  if (!friendUid) return;
  try {
    const messages = await api("messages", {}, { friend: friendUid });
    if (version !== conversationVersion || !connection) return;
    renderMessages(messages);
    await markConversationRead(friendUid, messages);
  } catch (error) {
    if (version === conversationVersion && connection) status("chatStatus", error.message, true);
  }
}

function selectChatFile() {
  const file = element("chatFile").files[0];
  if (!file) return clearChatFile();
  if (file.size > 3 * 1024 * 1024 || !file.size || !/\.(pdf|txt|md|csv|png|jpe?g|webp|gif|docx?|xlsx?|pptx?|zip)$/i.test(file.name)) {
    clearChatFile();
    status("chatStatus", "Choose a non-empty document, image, or ZIP file up to 3 MB.", true);
    return;
  }
  element("selectedFileName").textContent = `${file.name} · ${sizeLabel(file.size)}`;
  element("selectedFile").classList.remove("hidden");
  status("chatStatus");
}

function clearChatFile() {
  element("chatFile").value = "";
  element("selectedFile").classList.add("hidden");
  element("selectedFileName").textContent = "";
}

export async function sendChatMessage(event) {
  event.preventDefault();
  const friendUid = currentFriend;
  const version = conversationVersion;
  if (!friendUid || sending) return;
  const input = element("messageInput");
  const file = element("chatFile").files[0];
  if (!input.value.trim() && !file) return;
  const form = new FormData();
  form.set("friend", friendUid);
  form.set("text", input.value.trim());
  if (file) form.set("file", file);
  sending = true;
  input.disabled = true;
  element("chatFile").disabled = true;
  element("sendMessageBtn").disabled = true;
  element("sendMessageBtn").textContent = "Sending...";
  status("chatStatus", file ? "Uploading your file..." : "Sending your message...");
  try {
    await api("messages", { method: "POST", body: form });
    if (version !== conversationVersion || !connection) return;
    input.value = "";
    clearChatFile();
    status("chatStatus", "Sent.");
    await refreshMessages();
  } catch (error) {
    if (version === conversationVersion && connection) status("chatStatus", error.message, true);
  } finally {
    sending = false;
    input.disabled = false;
    element("chatFile").disabled = false;
    element("sendMessageBtn").disabled = false;
    element("sendMessageBtn").textContent = "Send";
  }
}

async function downloadFile(id, name, button) {
  button.disabled = true;
  try {
    const response = await api("file", {}, { id });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = node("a", "hidden");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) {
    if (connection) status("chatStatus", error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function refreshNotifications() {
  const controller = sessionController;
  try {
    const result = await api("notifications");
    if (controller !== sessionController || !connection) return;
    status("notificationStatus");
    const badge = element("notificationBadge");
    badge.textContent = result.unread > 99 ? "99+" : String(result.unread);
    badge.setAttribute("aria-label", `${result.unread} unread notifications`);
    badge.classList.toggle("hidden", !result.unread);
    element("markAllReadBtn").disabled = !result.unread;
    const list = element("notificationsList");
    list.replaceChildren();
    if (!result.items.length) list.append(node("div", "empty", "You're all caught up. New messages and shared files appear here."));
    for (const notification of result.items) {
      const button = node("button", `notification-card${notification.readAt ? "" : " unread"}`);
      button.type = "button";
      const details = node("span", "notification-details");
      details.append(node("strong", "", `${notification.senderName} ${notification.kind === "file" ? "shared a file" : "sent a message"}`), node("span", "", notification.preview), node("time", "", dateLabel(notification.createdAt)));
      button.append(node("span", "notification-marker", notification.kind === "file" ? "↓" : "✉"), details);
      button.onclick = async () => {
        window.showPage("chats");
        await openConversation(notification.senderUid);
      };
      list.append(button);
    }
  } catch (error) {
    if (controller === sessionController && connection) status("notificationStatus", error.message, true);
  }
}

async function markConversationRead(friendUid, messages) {
  if (!messages.length || !connection || currentFriend !== friendUid || !element("chats").classList.contains("active") || document.hidden) return;
  await api("notifications", jsonOptions("PATCH", { friend: friendUid, messageIds: messages.map(message => message.id) }));
  await refreshNotifications();
}

async function markAllNotificationsRead() {
  element("markAllReadBtn").disabled = true;
  try {
    await api("notifications", jsonOptions("PATCH", {}));
    await refreshNotifications();
  } catch (error) {
    if (connection) status("notificationStatus", error.message, true);
    element("markAllReadBtn").disabled = false;
  }
}

async function refreshPosts() {
  const controller = sessionController;
  if (!connection) return;
  status("postsStatus", "Refreshing posts...");
  try {
    const posts = await api("posts");
    if (controller !== sessionController || !connection) return;
    const list = element("postsList");
    list.replaceChildren();
    if (!posts.length) list.append(node("div", "empty", "Start the community board. Share the first note, tip, or question."));
    for (const post of posts) {
      const card = node("article", "post-card");
      const header = node("div", "post-meta");
      header.append(node("span", "subject-tag", post.subject), node("time", "", dateLabel(post.createdAt)));
      card.append(header, node("h3", "", post.title), node("p", "post-body", post.content));
      const footer = node("div", "post-footer");
      footer.append(node("span", "", `Shared by ${post.authorName}`));
      if (post.authorUid === connection.getUser().uid) {
        const button = node("button", "delete-post", "Delete my post");
        button.type = "button";
        button.onclick = () => deletePost(post.id, button);
        footer.append(button);
      }
      card.append(footer);
      list.append(card);
    }
    status("postsStatus", "Showing the latest 50 posts.");
  } catch (error) {
    if (controller === sessionController && connection) status("postsStatus", error.message, true);
  }
}

async function publishPost(event) {
  event.preventDefault();
  const button = element("publishPostBtn");
  if (button.disabled) return;
  const controller = sessionController;
  button.disabled = true;
  button.textContent = "Publishing...";
  status("postStatus");
  try {
    await api("posts", jsonOptions("POST", { title: element("postTitle").value, subject: element("postSubject").value, content: element("postContent").value }));
    if (controller !== sessionController || !connection) return;
    element("postForm").reset();
    status("postStatus", "Your post is shared with the community.");
    await refreshPosts();
  } catch (error) {
    if (controller === sessionController && connection) status("postStatus", error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Publish post";
  }
}

async function deletePost(id, button) {
  if (!window.confirm("Delete your post? This cannot be undone.")) return;
  button.disabled = true;
  try {
    await api("posts", { method: "DELETE" }, { id });
    await refreshPosts();
  } catch (error) {
    if (connection) status("postsStatus", error.message, true);
    button.disabled = false;
  }
}

async function refreshCommunity() {
  if (!connection || document.hidden || refreshing) return;
  refreshing = true;
  try {
    await refreshNotifications();
    if (currentFriend && element("chats").classList.contains("active")) await refreshMessages();
  } finally {
    refreshing = false;
  }
}

export function communityPageChanged(pageId) {
  if (!connection) return;
  if (pageId === "notifications") refreshNotifications();
  if (pageId === "notes") refreshPosts();
  if (pageId === "chats" && currentFriend) refreshMessages();
}

Object.assign(window, { selectChatFile, clearChatFile, markAllNotificationsRead, refreshPosts, publishPost });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshCommunity();
});
