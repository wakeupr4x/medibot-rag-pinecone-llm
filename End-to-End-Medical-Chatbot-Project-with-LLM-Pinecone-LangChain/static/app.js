(function () {
  const STORAGE_KEYS = {
    chats: 'medibot_chats',
    prefs: 'medibot_prefs',
  };

  const LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'hi', name: 'Hindi' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
  ];

  const SUGGESTIONS = [
    { text: 'Analyze symptoms', query: 'I have a headache, mild fever, and feel tired. What could it be?' },
    { text: 'Upload blood report', query: 'Can you analyze this blood report and tell me if anything is abnormal?' },
    { text: 'Medicine guidance', query: 'What is the standard dosage for paracetamol for an adult?' },
    { text: 'Diet recommendations', query: 'Suggest a diet plan for someone with high blood pressure.' },
    { text: 'Mental health support', query: 'I have been feeling anxious lately. Can you help me calm down?' },
    { text: 'Fitness suggestions', query: 'Create a low-impact fitness routine for a beginner.' },
  ];

  const QUICK_PROMPTS = [
    'Should I see a doctor?',
    'What tests should I ask for?',
    'What are the red flags?',
    'How can I monitor this at home?',
  ];

  const state = {
    chats: [],
    currentChatId: null,
    draft: '',
    language: 'en',
    darkMode: true,
    sidebarOpen: false,
    rightSidebarOpen: true,
    isRecording: false,
    isLoading: false,
    selectedFile: null,
    search: '',
    activeTab: 'chat',
    user: null,
    authReady: false,
    authError: '',
  };

  let fileInput;
  let cameraInput;
  let textArea;
  let messagesEl;
  let mediaRecorder;
  let audioChunks = [];
  let audioStream = null;
  let speechRecognition;

  function safeParse(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  async function apiFetchJson(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  }

  async function fetchSessionUser() {
    try {
      const res = await fetch('/api/me');
      const data = await res.json();
      state.user = data.authenticated ? data.user : null;
    } catch {
      state.user = null;
    } finally {
      state.authReady = true;
      render();
    }
  }

  async function loginUser(payload) {
    state.authError = '';
    try {
      const data = await apiFetchJson('/api/login', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      state.user = data.user;
      state.authReady = true;
      savePrefs();
      render();
    } catch (error) {
      state.authError = error.message || 'Unable to log in';
      render();
    }
  }

  async function logoutUser() {
    try {
      await apiFetchJson('/api/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch {
      // Ignore logout failures and clear client state anyway.
    }
    state.user = null;
    state.currentChatId = null;
    savePrefs();
    render();
  }

  function savePrefs() {
    localStorage.setItem(STORAGE_KEYS.prefs, JSON.stringify({
      language: state.language,
      darkMode: state.darkMode,
      currentChatId: state.currentChatId,
    }));
  }

  function saveChats() {
    localStorage.setItem(STORAGE_KEYS.chats, JSON.stringify(state.chats));
  }

  function getCurrentChat() {
    return state.chats.find((c) => c.id === state.currentChatId) || null;
  }

  function currentMessages() {
    const chat = getCurrentChat();
    return chat ? chat.messages : [];
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdown(text) {
    let s = escapeHtml(text || '');
    s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    s = s.replace(/(?:^|\n)([-*])\s+(.+)(?=\n|$)/g, (match) => {
      const items = match
        .trim()
        .split(/\n/)
        .map((line) => line.replace(/^[-*]\s+/, ''))
        .filter(Boolean)
        .map((line) => `<li>${line}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    });
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  function formatTime(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
  }

  function formatDate(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
  }

  function fileKind(file) {
    if (!file) return 'file';
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return 'pdf';
    if ((file.type || '').startsWith('image/')) return 'image';
    return 'file';
  }

  function newId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function titleFromText(text) {
    const clean = String(text || '').trim();
    if (!clean) return 'New consultation';
    return clean.length > 44 ? `${clean.slice(0, 44)}...` : clean;
  }

  function ensureCurrentChat() {
    if (state.currentChatId && state.chats.some((c) => c.id === state.currentChatId)) return;
    if (state.chats.length) state.currentChatId = state.chats[0].id;
    else state.currentChatId = null;
  }

  function setDarkMode(enabled) {
    state.darkMode = enabled;
    document.documentElement.classList.toggle('dark', enabled);
    document.body.style.colorScheme = enabled ? 'dark' : 'light';
    savePrefs();
    render();
  }

  function setLanguage(lang) {
    state.language = lang;
    savePrefs();
    render();
  }

  function openSidebar(value) {
    state.sidebarOpen = value;
    render();
  }

  function openRightRail(value) {
    state.rightSidebarOpen = value;
    render();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function rerenderMessages() {
    const node = document.getElementById('chat-messages');
    if (node) {
      node.outerHTML = buildMessagesSection();
      bindDynamicNodes();
      scrollToBottom();
    }
  }

  function renderMainArea() {
    const root = document.getElementById('root');
    root.innerHTML = buildApp();
    bindDynamicNodes();
    scrollToBottom();
  }

  function updateChat(chatId, updater) {
    state.chats = state.chats.map((chat) => (chat.id === chatId ? updater(chat) : chat));
    saveChats();
    ensureCurrentChat();
    render();
  }

  function appendMessage(chatId, message) {
    state.chats = state.chats.map((chat) => {
      if (chat.id !== chatId) return chat;
      return { ...chat, messages: [...chat.messages, message] };
    });
    saveChats();
    render();
  }

  function createChat(firstText) {
    const id = newId('chat');
    const chat = {
      id,
      title: titleFromText(firstText),
      createdAt: new Date().toISOString(),
      messages: [],
    };
    state.chats = [chat, ...state.chats];
    state.currentChatId = id;
    saveChats();
    savePrefs();
    return id;
  }

  function handleSuggestionClick(query) {
    state.draft = query;
    render();
    setTimeout(() => {
      if (textArea) {
        textArea.focus();
        textArea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, 0);
  }

  function startNewChat() {
    state.currentChatId = null;
    state.draft = '';
    state.selectedFile = null;
    if (fileInput) fileInput.value = '';
    if (cameraInput) cameraInput.value = '';
    if (window.innerWidth < 1024) {
      state.sidebarOpen = false;
      state.rightSidebarOpen = false;
    }
    savePrefs();
    render();
  }

  async function toggleRecording() {
    if (!state.isRecording) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        try {
          speechRecognition = new SpeechRecognition();
          speechRecognition.lang = state.language === 'hi' ? 'hi-IN' : 'en-US';
          speechRecognition.interimResults = false;
          speechRecognition.maxAlternatives = 1;
          speechRecognition.onresult = async (event) => {
            const transcript = event.results?.[0]?.[0]?.transcript || '';
            state.draft = transcript;
            render();
            await sendQuery({ textOverride: transcript });
          };
          speechRecognition.onerror = () => {
            alert('Voice mode could not start. Please use text input or open the app on localhost/HTTPS.');
          };
          speechRecognition.start();
          state.isRecording = true;
          render();
        } catch {
          alert('Voice mode needs HTTPS or localhost in this browser.');
        }
        return;
      }

      const canRecordAudio = window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder;
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(audioStream);
        audioChunks = [];
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunks.push(e.data);
        };
        mediaRecorder.onstop = () => {
          const blob = new Blob(audioChunks, { type: 'audio/webm' });
          sendQuery({ audioBlob: blob });
          if (audioStream) {
            audioStream.getTracks().forEach((track) => track.stop());
            audioStream = null;
          }
        };
        mediaRecorder.start();
        state.isRecording = true;
        render();
      } catch {
        if (SpeechRecognition) {
          try {
            speechRecognition = new SpeechRecognition();
            speechRecognition.lang = state.language === 'hi' ? 'hi-IN' : 'en-US';
            speechRecognition.interimResults = false;
            speechRecognition.maxAlternatives = 1;
            speechRecognition.onresult = async (event) => {
              const transcript = event.results?.[0]?.[0]?.transcript || '';
              state.draft = transcript;
              render();
              await sendQuery({ textOverride: transcript });
            };
            speechRecognition.onerror = () => {
              alert('Voice mode could not start. Please use text input or open the app on localhost/HTTPS.');
            };
            speechRecognition.start();
            state.isRecording = true;
            render();
            return;
          } catch {
            // fall through
          }
        }
        alert('Microphone access needs HTTPS or localhost in this browser.');
      }
      return;
    }

    if (speechRecognition) {
      try { speechRecognition.stop(); } catch {}
      speechRecognition = null;
      state.isRecording = false;
      render();
      return;
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    state.isRecording = false;
    render();
  }

  async function sendQuery({ textOverride = null, audioBlob = null } = {}) {
    const queryText = textOverride !== null ? textOverride : state.draft;
    const trimmed = String(queryText || '').trim();
    if (!trimmed && !state.selectedFile && !audioBlob) return;
    if (state.isLoading) return;

    let chatId = state.currentChatId;
    if (!chatId) chatId = createChat(trimmed || (state.selectedFile ? state.selectedFile.name : 'New consultation'));
    const chat = getCurrentChat();
    const history = (chat?.messages || []).map((m) => ({ sender: m.sender, text: m.text })).slice(-8);
    const timestamp = new Date().toISOString();
    const attachment = state.selectedFile;
    const userText = trimmed || (audioBlob ? 'Voice query' : state.selectedFile ? `Uploaded ${state.selectedFile.name}` : 'New query');
    const userMsg = {
      id: newId('user'),
      sender: 'user',
      text: userText,
      timestamp,
      hasImage: !!attachment,
      attachmentName: attachment?.name || null,
      attachmentKind: fileKind(attachment),
      transcription: null,
    };
    const botMsg = {
      id: newId('bot'),
      sender: 'bot',
      text: 'Thinking...',
      timestamp,
      pending: true,
      promptText: trimmed,
    };

    state.isLoading = true;
    state.draft = '';

    if (!chat || chat.id !== chatId || !chat.messages.length) {
      state.chats = state.chats.map((c) =>
        c.id === chatId ? { ...c, messages: [userMsg, botMsg] } : c
      );
    } else {
      appendMessage(chatId, userMsg);
      appendMessage(chatId, botMsg);
    }
    saveChats();
    render();

    const formData = new FormData();
    formData.append('msg', trimmed);
    formData.append('lang', state.language);
    formData.append('history', JSON.stringify(history));
    if (attachment) formData.append('attachment', attachment);
    if (audioBlob) formData.append('audio', audioBlob, 'voice.webm');

    try {
      const res = await fetch('/api/chat', { method: 'POST', body: formData });
      const data = await res.json();
      const finalText = data.success
        ? data.text
        : (data.error || 'Sorry, I could not process that request right now. Please try again.');
      state.chats = state.chats.map((chatItem) => {
        if (chatItem.id !== chatId) return chatItem;
        return {
          ...chatItem,
          title: chatItem.messages.length <= 2 ? titleFromText(trimmed || userText) : chatItem.title,
          messages: chatItem.messages.map((msg) => {
            if (msg.id !== botMsg.id) return msg;
            return {
              ...msg,
              text: finalText,
              pending: false,
              transcription: data.transcription || null,
            };
          }),
        };
      });
      if (attachment) {
        const existingReports = safeParse('medibot_reports', []);
        const nextReport = {
          id: newId('report'),
          name: attachment.name,
          kind: fileKind(attachment),
          createdAt: timestamp,
          chatId,
        };
        localStorage.setItem('medibot_reports', JSON.stringify([nextReport, ...existingReports].slice(0, 10)));
      }
    } catch {
      state.chats = state.chats.map((chatItem) => {
        if (chatItem.id !== chatId) return chatItem;
        return {
          ...chatItem,
          messages: chatItem.messages.map((msg) =>
            msg.id === botMsg.id ? { ...msg, text: 'Network error. Please try again.', pending: false } : msg
          ),
        };
      });
    } finally {
      state.isLoading = false;
      state.selectedFile = null;
      if (fileInput) fileInput.value = '';
      if (cameraInput) cameraInput.value = '';
      saveChats();
      savePrefs();
      render();
    }
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text || '');
  }

  function reactToMessage(messageId, reaction) {
    const chat = getCurrentChat();
    if (!chat) return;
    updateChat(chat.id, (current) => ({
      ...current,
      messages: current.messages.map((msg) => (msg.id === messageId ? { ...msg, reaction } : msg)),
    }));
  }

  function regenerateMessage(message) {
    if (!message?.promptText) return;
    state.draft = message.promptText;
    render();
    sendQuery({ textOverride: message.promptText });
  }

  function handleAttachmentChange(event) {
    const file = event.target.files && event.target.files[0];
    if (file) {
      state.selectedFile = file;
      render();
    }
  }

  function buildIcon(name, size = 18) {
    const common = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
    const paths = {
      chat: `<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>`,
      plus: `<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>`,
      menu: `<line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line>`,
      x: `<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>`,
      sun: `<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="M4.93 4.93l1.41 1.41"></path><path d="M17.66 17.66l1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="M6.34 17.66l-1.41 1.41"></path><path d="M19.07 4.93l-1.41 1.41"></path>`,
      moon: `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`,
      settings: `<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V22a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06A2 2 0 0 1 2.57 18.2l.06-.06A1.65 1.65 0 0 0 3 16.3a1.65 1.65 0 0 0-1.51-1H1.4a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 0 1 5.44 4.6l.06.06a1.65 1.65 0 0 0 1.82.33h.18A1.65 1.65 0 0 0 9 3.48V3.4a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06A2 2 0 0 1 21.43 5.8l-.06.06A1.65 1.65 0 0 0 21 7.7c0 .64.38 1.21.97 1.46H22a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>`,
      user: `<path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="7" r="4"></circle>`,
      send: `<path d="M22 2L11 13"></path><path d="M22 2l-7 20-4-9-9-4 20-7z"></path>`,
      mic: `<path d="M12 1v11"></path><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v4"></path>`,
      image: `<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path>`,
      paperclip: `<path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 1 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.49"></path>`,
      globe: `<circle cx="12" cy="12" r="10"></circle><path d="M2 12h20"></path><path d="M12 2a15.3 15.3 0 0 1 0 20"></path><path d="M12 2a15.3 15.3 0 0 0 0 20"></path>`,
      search: `<circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path>`,
      trash: `<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path>`,
      bell: `<path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5"></path><path d="M9 17a3 3 0 0 0 6 0"></path>`,
      bot: `<path d="M12 8V4"></path><path d="M8 12a4 4 0 1 0 8 0 4 4 0 0 0-8 0z"></path><path d="M4 19a8 8 0 0 1 16 0"></path>`,
      sparkles: `<path d="M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5L12 2z"></path><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"></path>`,
      activity: `<path d="M3 12h4l3-8 4 16 3-8h4"></path>`,
      heart: `<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 22l7.8-8.6 1-1a5.5 5.5 0 0 0 0-7.8z"></path>`,
      brain: `<path d="M9 5a4 4 0 0 1 6 3 3 3 0 0 1 1 5 3 3 0 0 1-2 5 4 4 0 0 1-6 0 3 3 0 0 1-2-5 3 3 0 0 1 1-5 4 4 0 0 1 2-3z"></path>`,
      shield: `<path d="M12 2l8 4v6c0 5-3.5 8.7-8 10-4.5-1.3-8-5-8-10V6l8-4z"></path><path d="M9 12l2 2 4-4"></path>`,
      file: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path>`,
      check: `<path d="M20 6 9 17l-5-5"></path>`,
      copy: `<rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>`,
      refresh: `<path d="M20 11a8 8 0 1 0-2 5.3"></path><path d="M20 4v7h-7"></path>`,
      thumbsUp: `<path d="M7 22V11H4v11h3z"></path><path d="M7 11l4-8a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2l-2 9H7"></path>`,
      thumbsDown: `<path d="M7 2v11H4V2h3z"></path><path d="M7 13l4 8a2 2 0 0 0 2-2v-4h6a2 2 0 0 0 2-2l-2-9H7"></path>`,
      history: `<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 3v6h6"></path><path d="M12 7v5l4 2"></path>`,
      camera: `<path d="M4 7h4l2-3h4l2 3h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"></path><circle cx="12" cy="13" r="3"></circle>`,
      panelRight: `<rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M15 3v18"></path>`,
      arrowUpRight: `<path d="M7 17L17 7"></path><path d="M7 7h10v10"></path>`,
      arrowDown: `<path d="M12 5v14"></path><path d="M5 12l7 7 7-7"></path>`,
      clock: `<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path>`,
      upload: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5-5 5 5"></path><path d="M12 5v12"></path>`,
    };
    return `<svg ${common} aria-hidden="true">${paths[name] || ''}</svg>`;
  }

  function messageActions(message) {
    return `
      <div class="message-actions">
        <button class="action-chip" data-action="copy" data-message="${message.id}" title="Copy">${buildIcon('copy', 14)}</button>
        ${message.sender === 'bot' && message.promptText ? `<button class="action-chip" data-action="regenerate" data-message="${message.id}" title="Regenerate">${buildIcon('refresh', 14)}</button>` : ''}
        ${message.sender === 'bot' ? `<button class="action-chip" data-action="reaction" data-reaction="up" data-message="${message.id}" title="Helpful">${buildIcon('thumbsUp', 14)}</button>` : ''}
        ${message.sender === 'bot' ? `<button class="action-chip" data-action="reaction" data-reaction="down" data-message="${message.id}" title="Not helpful">${buildIcon('thumbsDown', 14)}</button>` : ''}
      </div>
    `;
  }

  function renderChatList() {
    const needle = state.search.trim().toLowerCase();
    const chats = needle
      ? state.chats.filter((chat) => {
          const titleHit = (chat.title || '').toLowerCase().includes(needle);
          const messageHit = (chat.messages || []).some((message) => (message.text || '').toLowerCase().includes(needle));
          return titleHit || messageHit;
        })
      : state.chats;

    if (!chats.length) {
      return `<div class="rounded-2xl border border-dashed border-slate-200 bg-white/60 p-4 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/60">No chats yet. Start with a symptom, report, or health goal.</div>`;
    }

    return chats.map((chat) => `
      <div class="group flex cursor-pointer items-center gap-3 rounded-2xl border px-3 py-3 transition-all ${state.currentChatId === chat.id ? 'border-medical-200 bg-medical-50/70 text-medical-900 shadow-sm dark:border-medical-500/20 dark:bg-medical-500/10 dark:text-medical-50' : 'border-transparent hover:border-slate-200 hover:bg-white/70 dark:hover:border-slate-700 dark:hover:bg-slate-900/70'}" data-chat-id="${chat.id}">
        <div class="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-medical-500/15 to-calm-500/15 text-medical-600">${buildIcon('chat', 16)}</div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-semibold">${escapeHtml(chat.title)}</div>
          <div class="truncate text-[11px] text-slate-500 dark:text-slate-400">${formatDate(chat.createdAt)} - ${(chat.messages || []).length} messages</div>
        </div>
        <button class="opacity-0 transition-opacity group-hover:opacity-100 rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-rose-500 dark:hover:bg-slate-800" data-delete-chat="${chat.id}">${buildIcon('trash', 14)}</button>
      </div>
    `).join('');
  }

  function renderSavedReports() {
    const reports = JSON.parse(localStorage.getItem('medibot_reports') || '[]');
    if (!reports.length) {
      return `<div class="rounded-2xl border border-slate-200 bg-white/60 p-4 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/60">Uploaded reports will appear here.</div>`;
    }
    return reports.slice(0, 4).map((report) => `
      <div class="rounded-2xl border border-slate-200 bg-white/75 p-3 dark:border-slate-700 dark:bg-slate-900/75">
        <div class="flex items-start gap-3">
          <div class="rounded-xl bg-medical-500/10 p-2 text-medical-600">${buildIcon(report.kind === 'pdf' ? 'file' : 'image', 16)}</div>
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-semibold">${escapeHtml(report.name)}</div>
            <div class="text-[11px] text-slate-500 dark:text-slate-400">${formatDate(report.createdAt)} - ${report.kind.toUpperCase()}</div>
          </div>
        </div>
      </div>
    `).join('');
  }

  function renderSidebar() {
    return `
      <div class="sidebar-surface flex h-full flex-col">
        <div class="border-b border-slate-200/70 px-4 py-4 dark:border-slate-700/60">
          <div class="mb-4 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="brand-mark">${buildIcon('sparkles', 18)}</div>
              <div>
                <div class="brand-title text-lg font-bold tracking-tight">Medibot AI</div>
                <div class="text-xs text-slate-500 dark:text-slate-400">Premium health copilot</div>
              </div>
            </div>
            <button class="md:hidden rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" data-close-sidebar>${buildIcon('x', 18)}</button>
          </div>

          <button class="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-medical-600 to-calm-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-medical-500/20" data-new-chat>
            ${buildIcon('plus', 16)} New chat
          </button>

          <div class="mt-4 relative">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">${buildIcon('search', 15)}</span>
            <input value="${escapeHtml(state.search)}" data-search-input placeholder="Search chats..." class="w-full rounded-2xl border border-slate-200 bg-white/80 py-3 pl-9 pr-4 text-sm outline-none placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-900/80" />
          </div>
        </div>

        <div class="flex-1 overflow-y-auto px-3 py-4 no-scrollbar">
          <div class="mb-4 px-2">
            <div class="mb-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-400">Recent consults</div>
            <div class="space-y-1.5">${renderChatList()}</div>
          </div>

          <div class="px-2">
            <div class="mb-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-400">Saved reports</div>
            <div class="space-y-2">${renderSavedReports()}</div>
          </div>
        </div>

        <div class="border-t border-slate-200/70 px-4 py-4 dark:border-slate-700/60">
          <div class="mini-stat">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Patient profile</div>
                <div class="mt-1 text-sm font-bold">Medibot user</div>
              </div>
              <div class="rounded-2xl bg-medical-500/10 p-2 text-medical-600">${buildIcon('user', 18)}</div>
            </div>
            <div class="mt-4 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">${buildIcon('clock', 14)} AI memory enabled</div>
            <div class="mt-3 flex items-center justify-between">
              <button class="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-white dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800" data-toggle-theme>${state.darkMode ? 'Light mode' : 'Dark mode'}</button>
              <button class="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-white dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800" data-logout>Logout</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function rightRailHTML() {
    const reports = safeParse('medibot_reports', []);
    const chats = state.chats.length;
    const messages = state.chats.reduce((sum, chat) => sum + (chat.messages ? chat.messages.length : 0), 0);
    const avgMessages = chats ? (messages / chats).toFixed(1) : '0.0';
    const lastChat = state.chats[0]?.createdAt || null;
    const freshness = lastChat ? Math.max(1, Math.ceil((Date.now() - new Date(lastChat).getTime()) / 86400000)) : 0;
    const lastHealthScore = Math.min(98, 55 + chats * 4 + reports.length * 6 + Math.min(12, Math.floor(messages / 2)));
    const stats = [
      { label: 'Consultations', value: String(chats) },
      { label: 'Saved reports', value: String(reports.length) },
      { label: 'Avg messages/chat', value: avgMessages },
      { label: 'Freshness', value: freshness ? `${freshness}d` : 'New' },
    ];
    return `
      <div class="flex h-full flex-col gap-4 overflow-y-auto px-5 py-5 no-scrollbar">
        <div class="rounded-[28px] border border-slate-200 bg-white/80 p-5 shadow-soft dark:border-slate-700 dark:bg-slate-900/80">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-[11px] font-bold uppercase tracking-[0.24em] text-slate-400">Activity score</div>
              <div class="mt-2 text-3xl font-black tracking-tight">${lastHealthScore}%</div>
            </div>
            <div class="rounded-2xl bg-calm-500/10 p-3 text-calm-600">${buildIcon('sparkles', 18)}</div>
          </div>
          <div class="mt-4 h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div class="h-full rounded-full bg-gradient-to-r from-medical-500 to-calm-500" style="width:${lastHealthScore}%"></div>
          </div>
          <p class="mt-3 text-sm text-slate-500 dark:text-slate-400">This score is computed from consultations, saved reports, and message depth. It is not a medical diagnosis.</p>
        </div>

        <div class="rounded-[28px] border border-slate-200 bg-white/80 p-5 shadow-soft dark:border-slate-700 dark:bg-slate-900/80">
          <div class="mb-4 flex items-center justify-between">
            <div>
              <div class="text-[11px] font-bold uppercase tracking-[0.24em] text-slate-400">Health dashboard</div>
              <div class="mt-1 text-lg font-bold">Usage snapshot</div>
            </div>
            ${buildIcon('activity', 18)}
          </div>
          <div class="grid grid-cols-2 gap-3">
            ${stats.map((item) => `
              <div class="rounded-2xl border border-slate-200 bg-white/80 p-3 dark:border-slate-700 dark:bg-slate-950/60">
                <div class="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">${item.label}</div>
                <div class="mt-2 text-xl font-black tracking-tight">${item.value}</div>
                <div class="mt-2 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800"><div class="h-full rounded-full bg-gradient-to-r from-medical-500 to-calm-500" style="width:72%"></div></div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="rounded-[28px] border border-slate-200 bg-white/80 p-5 shadow-soft dark:border-slate-700 dark:bg-slate-900/80">
          <div class="mb-4 flex items-center justify-between">
            <div>
              <div class="text-[11px] font-bold uppercase tracking-[0.24em] text-slate-400">Suggested actions</div>
              <div class="mt-1 text-lg font-bold">Next best steps</div>
            </div>
            ${buildIcon('arrowUpRight', 18)}
          </div>
          <div class="space-y-3">
            ${[
              'Track symptoms for 3 days to spot a pattern.',
              'Upload reports to compare values across visits.',
              'Use voice mode for hands-free consultation.',
              'Keep questions short for clearer medical guidance.',
            ].map((item) => `
              <div class="flex items-start gap-3 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-950/50">
                <div class="mt-0.5 rounded-full bg-medical-500/10 p-1.5 text-medical-600">${buildIcon('check', 12)}</div>
                <div class="text-sm text-slate-600 dark:text-slate-300">${item}</div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="rounded-[28px] border border-slate-200 bg-gradient-to-br from-medical-600 to-calm-500 p-5 text-white shadow-soft">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-[11px] font-bold uppercase tracking-[0.24em] text-white/70">Smart report analyzer</div>
              <div class="mt-2 text-xl font-black">Upload PDF or image</div>
              <p class="mt-2 text-sm text-white/85">Extract values, highlight abnormalities, and get a concise clinical summary.</p>
            </div>
            ${buildIcon('file', 22)}
          </div>
          <button class="mt-4 w-full rounded-2xl bg-white/15 px-4 py-3 text-sm font-semibold text-white backdrop-blur hover:bg-white/20" data-upload-report>Upload report</button>
        </div>
      </div>
    `;
  }

  function heroHTML() {
    return `
      <div class="mx-auto flex min-h-[calc(100vh-240px)] max-w-6xl items-center justify-center px-4 py-8">
        <div class="grid w-full items-center gap-10 lg:grid-cols-[1.05fr_0.95fr]">
          <div class="text-center lg:text-left">
            <div class="mb-4 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-4 py-2 text-xs font-semibold text-slate-600 shadow-soft dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-300">
              <span class="status-dot"></span>
              AI specialist online
            </div>
            <h1 class="brand-title text-4xl font-black tracking-tight md:text-6xl">How can I help you <span class="accent-gradient">today?</span></h1>
            <p class="mx-auto mt-5 max-w-2xl text-base leading-8 text-slate-600 dark:text-slate-300 lg:mx-0">Medibot AI is a premium healthcare copilot for symptoms, reports, medication questions, nutrition guidance, wellness planning, and calm human-friendly support.</p>
            <div class="mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              ${QUICK_PROMPTS.map((prompt) => `<button class="health-pill border border-slate-200 bg-white/80 text-slate-700 shadow-soft hover:-translate-y-0.5 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-200" data-suggest="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>`).join('')}
            </div>
          </div>

          <div class="flex justify-center">
            <div class="hero-visual">
              <div class="hero-orbit"></div>
              <div class="hero-arc"></div>
              <div class="hero-arc alt"></div>
              <div class="hero-core">
                <div class="text-center">
                  <div class="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-medical-600 to-calm-500 text-white shadow-lg">${buildIcon('bot', 30)}</div>
                  <div class="text-sm font-bold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Medibot AI</div>
                  <div class="mt-2 text-2xl font-black tracking-tight">Health copilot</div>
                  <div class="mt-2 text-sm text-slate-500 dark:text-slate-400">Symptom analysis, report review, and support.</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function loginHTML() {
    if (!state.authReady) {
      return `
        <div class="flex min-h-screen items-center justify-center p-6">
          <div class="glass-panel rounded-[28px] px-6 py-5 text-sm text-slate-500 dark:text-slate-300">
            Loading Medibot AI...
          </div>
        </div>
      `;
    }

    return `
      <div class="auth-shell flex min-h-screen items-center justify-center px-4 py-10">
        <div class="grid w-full max-w-6xl gap-6 lg:grid-cols-[1fr_1.05fr]">
          <div class="glass-panel rounded-[32px] p-6 md:p-8">
            <div class="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-4 py-2 text-xs font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-300">
              <span class="status-dot"></span>
              Secure session login
            </div>
            <h1 class="mt-5 brand-title text-4xl font-black tracking-tight md:text-6xl">
              Welcome to <span class="accent-gradient">Medibot AI</span>
            </h1>
            <p class="mt-4 max-w-xl text-base leading-8 text-slate-600 dark:text-slate-300">
              Sign in to access your health assistant, saved reports, symptom history, and personalized guidance.
            </p>

            <div class="mt-8 grid gap-3 sm:grid-cols-2">
              <div class="mini-stat">
                <div class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Symptoms</div>
                <div class="mt-2 text-lg font-bold">Fast triage</div>
              </div>
              <div class="mini-stat">
                <div class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Reports</div>
                <div class="mt-2 text-lg font-bold">Image + PDF analysis</div>
              </div>
              <div class="mini-stat">
                <div class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Voice</div>
                <div class="mt-2 text-lg font-bold">Speech fallback</div>
              </div>
              <div class="mini-stat">
                <div class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Memory</div>
                <div class="mt-2 text-lg font-bold">Persistent sessions</div>
              </div>
            </div>

            <div class="mt-8 doctor-card rounded-[28px] p-5">
              <div class="flex items-center gap-4">
                <div class="doctor-avatar">${buildIcon('user', 28)}</div>
                <div>
                  <div class="text-xs font-bold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Trusted care guide</div>
                  <div class="mt-1 text-xl font-black tracking-tight">Dr. AI Care</div>
                  <div class="mt-1 text-sm text-slate-500 dark:text-slate-400">Always calm. Always clear.</div>
                </div>
              </div>
              <div class="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div class="h-full w-2/3 rounded-full bg-gradient-to-r from-medical-500 to-calm-500 animate-pulse"></div>
              </div>
            </div>
          </div>

          <div class="glass-panel rounded-[32px] p-6 md:p-8">
            <div class="mb-8 flex items-start justify-between gap-4">
              <div>
                <div class="text-[11px] font-bold uppercase tracking-[0.24em] text-slate-400">Sign in</div>
                <div class="mt-2 text-2xl font-black tracking-tight">Enter your profile</div>
              </div>
              <div class="rounded-3xl bg-gradient-to-br from-medical-600 to-calm-500 p-4 text-white shadow-lg shadow-medical-500/20">
                ${buildIcon('sparkles', 22)}
              </div>
            </div>

            ${state.authError ? `<div class="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">${escapeHtml(state.authError)}</div>` : ''}

            <div class="space-y-4">
              <label class="block">
                <span class="mb-2 block text-sm font-semibold text-slate-600 dark:text-slate-300">Name</span>
                <input id="login-name" class="w-full rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 outline-none placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-900/80" placeholder="Your name" />
              </label>
              <label class="block">
                <span class="mb-2 block text-sm font-semibold text-slate-600 dark:text-slate-300">Email</span>
                <input id="login-email" type="email" class="w-full rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 outline-none placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-900/80" placeholder="you@example.com" />
              </label>
              <label class="block">
                <span class="mb-2 block text-sm font-semibold text-slate-600 dark:text-slate-300">Password</span>
                <input id="login-password" type="password" class="w-full rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 outline-none placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-900/80" placeholder="Any password for this demo session" />
              </label>
              <button class="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-medical-600 to-calm-500 px-4 py-3 font-semibold text-white shadow-lg shadow-medical-500/20" data-login-submit>
                ${buildIcon('check', 16)} Continue to Medibot
              </button>
            </div>

            <div class="mt-6 grid gap-3 sm:grid-cols-2">
              <div class="mini-stat">
                <div class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Security</div>
                <div class="mt-2 text-sm font-semibold">Session-based demo login</div>
              </div>
              <div class="mini-stat">
                <div class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Voice note</div>
                <div class="mt-2 text-sm font-semibold">Mic works best on localhost or HTTPS</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function chatMessagesHTML() {
    const messages = currentMessages();
    if (!messages.length) return heroHTML();

    const items = messages.map((message) => `
      <div class="message-card flex gap-3 md:gap-4 ${message.sender === 'user' ? 'flex-row-reverse' : ''}">
        <div class="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${message.sender === 'user' ? 'border-transparent bg-medical-600 text-white shadow-lg shadow-medical-500/20' : 'border-slate-200 bg-white text-medical-600 dark:border-slate-700 dark:bg-slate-900'}">
          ${message.sender === 'user' ? buildIcon('user', 14) : buildIcon('bot', 16)}
        </div>

        <div class="min-w-0 flex-1 ${message.sender === 'user' ? 'max-w-[88%] md:max-w-[76%]' : 'max-w-[92%] md:max-w-[80%]'}">
          ${message.transcription ? `<div class="mb-2 inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">${buildIcon('mic', 11)} Voice transcription</div>` : ''}
          <div class="message-meta mb-2 flex items-center gap-2 ${message.sender === 'user' ? 'justify-end' : 'justify-start'}">
            <span>${formatTime(message.timestamp)}</span>
            ${message.sender === 'bot' && message.pending ? `<span class="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-600 dark:text-cyan-300"><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-500"></span>Streaming</span>` : ''}
          </div>
          <div class="message-bubble ${message.sender === 'user' ? 'message-user' : 'message-ai'}">
            <div class="prose-md text-[15px] leading-7">${renderMarkdown(message.text)}</div>
            ${message.attachmentName ? `<div class="mt-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold backdrop-blur-sm ${message.sender === 'user' ? 'text-white' : 'text-slate-600 dark:text-slate-200'}">${buildIcon(message.attachmentKind === 'pdf' ? 'file' : 'image', 12)} ${escapeHtml(message.attachmentName)}</div>` : ''}
            ${message.reaction ? `<div class="mt-3 text-[11px] font-semibold opacity-80">Reacted: ${message.reaction === 'up' ? 'Helpful' : 'Needs improvement'}</div>` : ''}
          </div>
          <div class="mt-2 flex items-center ${message.sender === 'user' ? 'justify-end' : 'justify-start'}">${messageActions(message)}</div>
        </div>
      </div>
    `).join('');

    const typing = state.isLoading ? `
      <div class="message-card flex gap-3 md:gap-4">
        <div class="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white text-medical-600 dark:border-slate-700 dark:bg-slate-900">${buildIcon('bot', 16)}</div>
        <div class="min-w-0 flex-1">
          <div class="message-meta mb-2">Typing...</div>
          <div class="message-bubble message-ai flex items-center gap-2">
            <div class="skeleton h-2.5 w-2.5 rounded-full"></div>
            <div class="skeleton h-2.5 w-2.5 rounded-full"></div>
            <div class="skeleton h-2.5 w-2.5 rounded-full"></div>
          </div>
        </div>
      </div>
    ` : '';

    return `
      <div id="chat-messages" class="flex-1 overflow-y-auto p-4 md:p-8 scroll-smooth no-scrollbar">
        <div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
          ${messages.length ? `<div class="mb-3 flex flex-wrap items-center justify-between gap-3"><div class="rounded-full border border-slate-200 bg-white/80 px-4 py-2 text-xs font-semibold text-slate-500 shadow-soft dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-300">${escapeHtml(getCurrentChat()?.title || 'Conversation')}</div><div class="flex items-center gap-2"><span class="health-pill">${buildIcon('activity', 12)} Streaming ready</span><span class="health-pill">${buildIcon('clock', 12)} ${messages.length} messages</span></div></div>` : ''}
          ${items}
          ${typing}
          <div class="h-2"></div>
        </div>
      </div>
    `;
  }

  function composerHTML() {
    const activeChips = SUGGESTIONS.slice(0, 4);
    return `
      <div class="composer-shell">
        <div class="mx-auto max-w-4xl">
          <div class="mb-3 flex flex-wrap items-center gap-2 px-1">
            ${activeChips.map((item) => `<button class="health-pill border border-slate-200 bg-white/80 text-slate-700 shadow-soft hover:-translate-y-0.5 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-200" data-suggest="${escapeHtml(item.query)}">${buildIcon('sparkles', 12)} ${escapeHtml(item.text)}</button>`).join('')}
          </div>

          <div class="composer-inner">
            <input id="file-input" type="file" accept="image/*,.pdf" class="hidden" />
            <input id="camera-input" type="file" accept="image/*" capture="environment" class="hidden" />

            ${state.selectedFile ? `<div class="mb-3 flex items-center justify-between rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950/60"><div class="flex min-w-0 items-center gap-2"><div class="rounded-xl bg-medical-500/10 p-2 text-medical-600">${buildIcon(fileKind(state.selectedFile) === 'pdf' ? 'file' : 'image', 14)}</div><div class="min-w-0"><div class="truncate font-semibold">${escapeHtml(state.selectedFile.name)}</div><div class="text-[11px] text-slate-500 dark:text-slate-400">${fileKind(state.selectedFile).toUpperCase()} attachment ready</div></div></div><button class="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-rose-500 dark:hover:bg-slate-800" data-clear-file>${buildIcon('x', 14)}</button></div>` : ''}

            <div class="flex items-end gap-2">
              <button class="mic-badge" title="Upload report" data-upload>${buildIcon('paperclip', 18)}</button>
              <button class="mic-badge" title="Camera upload" data-camera>${buildIcon('camera', 18)}</button>
              <button class="mic-badge ${state.isRecording ? 'active' : ''}" title="Voice recording" data-record>${buildIcon('mic', 18)}</button>

              <div class="min-w-0 flex-1 rounded-[22px] border border-slate-200 bg-white/70 px-4 py-3 dark:border-slate-700 dark:bg-slate-950/50">
                <textarea id="composer" class="composer-input" rows="1" placeholder="Describe symptoms, ask about a report, or request a diet and fitness plan...">${escapeHtml(state.draft)}</textarea>
              </div>

              <button class="flex h-14 w-14 items-center justify-center rounded-[20px] bg-gradient-to-r from-medical-600 to-calm-500 text-white shadow-lg shadow-medical-500/20 disabled:cursor-not-allowed disabled:opacity-50" data-send ${state.isLoading ? 'disabled' : ''}>${buildIcon('send', 18)}</button>
            </div>

            <div class="mt-3 flex flex-wrap items-center justify-between gap-2 px-1">
              <div class="text-[11px] text-slate-500 dark:text-slate-400">For emergencies, call local emergency services. Medibot AI is not a replacement for a doctor.</div>
              <div class="inline-flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">${buildIcon('check', 12)} Markdown, voice, and attachments enabled</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function topHeaderHTML() {
    return `
      <header class="top-header">
        <div class="flex items-center justify-between gap-4 px-4 py-3 md:px-6">
          <div class="flex min-w-0 items-center gap-3">
            <button class="rounded-2xl p-2 text-slate-500 hover:bg-white/70 dark:hover:bg-slate-900/70 lg:hidden" data-open-sidebar>${buildIcon('menu', 22)}</button>
            <div class="flex min-w-0 items-center gap-3">
              <div class="brand-mark shadow-lg shadow-medical-500/20">${buildIcon('sparkles', 18)}</div>
              <div class="min-w-0">
                <div class="brand-title truncate text-lg font-bold tracking-tight md:text-xl">Medibot AI</div>
                <div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400"><span class="status-dot"></span> AI specialist online</div>
              </div>
            </div>
          </div>

          <div class="hidden min-w-0 items-center gap-2 md:flex">
            <div class="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900/80">
              <span class="mr-2 inline-flex items-center gap-1 text-slate-500 dark:text-slate-400">${buildIcon('globe', 14)} Language</span>
              <select id="language-select" class="bg-transparent text-sm font-semibold outline-none">
                ${LANGUAGES.map((lang) => `<option value="${lang.code}" ${lang.code === state.language ? 'selected' : ''}>${lang.name}</option>`).join('')}
              </select>
            </div>

            <button class="relative rounded-2xl border border-slate-200 bg-white/80 p-3 text-slate-500 hover:text-medical-600 dark:border-slate-700 dark:bg-slate-900/80" data-toggle-theme>${buildIcon(state.darkMode ? 'sun' : 'moon', 18)}</button>
            <button class="rounded-2xl border border-slate-200 bg-white/80 p-3 text-slate-500 hover:text-medical-600 dark:border-slate-700 dark:bg-slate-900/80" data-toggle-rail>${buildIcon('panelRight', 18)}</button>
            <button class="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-sm font-semibold dark:border-slate-700 dark:bg-slate-900/80" data-logout><span class="inline-flex items-center gap-2">${buildIcon('user', 14)} ${escapeHtml(state.user?.name || 'Patient')}</span></button>
          </div>
        </div>
      </header>
    `;
  }

  function rightRailContainer() {
    return `
      <div class="hidden xl:block border-l border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
        ${rightRailHTML()}
      </div>
    `;
  }

  function desktopSidebarContainer() {
    return `<div class="hidden lg:flex">${renderSidebar()}</div>`;
  }

  function mobileOverlay() {
    if (!state.sidebarOpen) return '';
    return `
      <div class="fixed inset-0 z-20 bg-black/50 md:hidden backdrop-blur-sm" data-close-sidebar-overlay></div>
      <div class="fixed inset-y-0 left-0 z-30 w-[88%] max-w-sm">${renderSidebar()}</div>
    `;
  }

  function mobileBottomNav() {
    return `
      <div class="bottom-nav lg:hidden">
        <button data-mobile-tab="chat" data-active="${state.activeTab === 'chat'}">${buildIcon('chat', 18)}<span class="text-[10px] font-semibold">Chat</span></button>
        <button data-mobile-tab="history" data-active="${state.activeTab === 'history'}">${buildIcon('history', 18)}<span class="text-[10px] font-semibold">History</span></button>
        <button data-mobile-tab="health" data-active="${state.activeTab === 'health'}">${buildIcon('heart', 18)}<span class="text-[10px] font-semibold">Health</span></button>
        <button data-mobile-tab="settings" data-active="${state.activeTab === 'settings'}">${buildIcon('settings', 18)}<span class="text-[10px] font-semibold">Settings</span></button>
      </div>
    `;
  }

  function buildApp() {
    if (!state.user) return loginHTML();
    const chatArea = chatMessagesHTML();
    return `
      <div class="app-shell shell-grid">
        ${desktopSidebarContainer()}
        <div class="flex min-w-0 flex-col">
          ${topHeaderHTML()}
          <main class="flex min-h-0 flex-1 flex-col">
            ${chatArea}
            ${composerHTML()}
          </main>
        </div>
        ${state.rightSidebarOpen ? rightRailContainer() : ''}
        ${mobileOverlay()}
        ${mobileBottomNav()}
      </div>
    `;
  }

  function bindDynamicNodes() {
    fileInput = document.getElementById('file-input');
    cameraInput = document.getElementById('camera-input');
    textArea = document.getElementById('composer');
    messagesEl = document.getElementById('chat-messages');

    const root = document.getElementById('root');

    const loginSubmit = root.querySelector('[data-login-submit]');
    if (loginSubmit) {
      loginSubmit.addEventListener('click', () => {
        const name = root.querySelector('#login-name')?.value?.trim();
        const email = root.querySelector('#login-email')?.value?.trim();
        const password = root.querySelector('#login-password')?.value?.trim();
        loginUser({ name, email, password });
      });
    }

    ['#login-name', '#login-email', '#login-password'].forEach((selector) => {
      const input = root.querySelector(selector);
      if (!input) return;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          loginSubmit?.click();
        }
      });
    });

    root.querySelectorAll('[data-suggest]').forEach((btn) => {
      btn.addEventListener('click', () => handleSuggestionClick(btn.getAttribute('data-suggest')));
    });

    root.querySelectorAll('[data-chat-id]').forEach((row) => {
      row.addEventListener('click', () => {
        state.currentChatId = row.getAttribute('data-chat-id');
        state.activeTab = 'chat';
        state.sidebarOpen = false;
        savePrefs();
        render();
      });
    });

    root.querySelectorAll('[data-delete-chat]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-delete-chat');
        state.chats = state.chats.filter((chat) => chat.id !== id);
        if (state.currentChatId === id) state.currentChatId = null;
        saveChats();
        savePrefs();
        render();
      });
    });

    const searchInput = root.querySelector('[data-search-input]');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.search = e.target.value;
        render();
      });
    }

    const languageSelect = root.querySelector('#language-select');
    if (languageSelect) {
      languageSelect.addEventListener('change', (e) => setLanguage(e.target.value));
    }

    root.querySelectorAll('[data-open-sidebar]').forEach((btn) => btn.addEventListener('click', () => {
      state.sidebarOpen = true;
      render();
    }));

    root.querySelectorAll('[data-close-sidebar]').forEach((btn) => btn.addEventListener('click', () => {
      state.sidebarOpen = false;
      render();
    }));

    root.querySelectorAll('[data-close-sidebar-overlay]').forEach((btn) => btn.addEventListener('click', () => {
      state.sidebarOpen = false;
      render();
    }));

    root.querySelectorAll('[data-toggle-theme]').forEach((btn) => btn.addEventListener('click', () => setDarkMode(!state.darkMode)));
    root.querySelectorAll('[data-toggle-rail]').forEach((btn) => btn.addEventListener('click', () => {
      state.rightSidebarOpen = !state.rightSidebarOpen;
      render();
    }));
    root.querySelectorAll('[data-logout]').forEach((btn) => btn.addEventListener('click', logoutUser));
    root.querySelectorAll('[data-upload-report]').forEach((btn) => btn.addEventListener('click', () => fileInput?.click()));
    root.querySelectorAll('[data-upload]').forEach((btn) => btn.addEventListener('click', () => fileInput?.click()));
    root.querySelectorAll('[data-camera]').forEach((btn) => btn.addEventListener('click', () => cameraInput?.click()));
    root.querySelectorAll('[data-record]').forEach((btn) => btn.addEventListener('click', toggleRecording));
    root.querySelectorAll('[data-clear-file]').forEach((btn) => btn.addEventListener('click', () => {
      state.selectedFile = null;
      render();
    }));
    root.querySelectorAll('[data-send]').forEach((btn) => btn.addEventListener('click', () => sendQuery()));
    root.querySelectorAll('[data-new-chat]').forEach((btn) => btn.addEventListener('click', startNewChat));

    root.querySelectorAll('[data-mobile-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.getAttribute('data-mobile-tab');
        if (state.activeTab === 'history') state.sidebarOpen = true;
        if (state.activeTab === 'health') state.rightSidebarOpen = true;
        if (state.activeTab === 'settings') state.rightSidebarOpen = false;
        if (state.activeTab === 'chat') {
          state.sidebarOpen = false;
          state.rightSidebarOpen = false;
        }
        render();
      });
    });

    if (fileInput) fileInput.addEventListener('change', handleAttachmentChange);
    if (cameraInput) cameraInput.addEventListener('change', handleAttachmentChange);
    if (textArea) {
      textArea.addEventListener('input', (e) => {
        state.draft = e.target.value;
        textArea.style.height = '0px';
        textArea.style.height = `${Math.min(textArea.scrollHeight, 164)}px`;
      });
      textArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendQuery();
        }
      });
      textArea.style.height = '0px';
      textArea.style.height = `${Math.min(textArea.scrollHeight, 164)}px`;
    }

    root.querySelectorAll('[data-action="copy"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const chat = getCurrentChat();
        const msg = chat?.messages.find((m) => m.id === btn.getAttribute('data-message'));
        if (msg) copyText(msg.text);
      });
    });

    root.querySelectorAll('[data-action="regenerate"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const chat = getCurrentChat();
        const msg = chat?.messages.find((m) => m.id === btn.getAttribute('data-message'));
        if (msg) regenerateMessage(msg);
      });
    });

    root.querySelectorAll('[data-action="reaction"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        reactToMessage(btn.getAttribute('data-message'), btn.getAttribute('data-reaction'));
      });
    });
  }

  function render() {
    ensureCurrentChat();
    document.documentElement.classList.toggle('dark', state.darkMode);
    document.body.style.colorScheme = state.darkMode ? 'dark' : 'light';
    document.getElementById('root').innerHTML = buildApp();
    bindDynamicNodes();
    scrollToBottom();
  }

  async function init() {
    state.chats = safeParse(STORAGE_KEYS.chats, []);
    const prefs = safeParse(STORAGE_KEYS.prefs, {});
    state.language = prefs.language || 'en';
    state.darkMode = typeof prefs.darkMode === 'boolean' ? prefs.darkMode : true;
    state.currentChatId = prefs.currentChatId || (state.chats[0] && state.chats[0].id) || null;
    document.documentElement.classList.toggle('dark', state.darkMode);
    document.body.style.colorScheme = state.darkMode ? 'dark' : 'light';
    await fetchSessionUser();
  }

  window.addEventListener('resize', () => {
    if (window.innerWidth >= 1024) {
      state.sidebarOpen = false;
    }
  });

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
