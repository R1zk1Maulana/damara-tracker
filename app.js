/**
 * ============================================================
 * Damara Mobile Tracker — app.js
 * Arsitektur : MVVM (Model — ViewModel — View)
 * Teknologi  : HTML5, CSS3, Vanilla JavaScript (ES2022+)
 * Pola reaktif: Proxy + EventBus (simulasi two-way binding)
 * ============================================================
 */
(() => {
  'use strict';

  /* ==========================================================
   * 1. KONFIGURASI GLOBAL
   * ========================================================== */
  const CONFIG = Object.freeze({
    maxLogs: 150,
    nameLimit: 60,
    descLimit: 280,
    minNameLength: 3,
    minDescLength: 5,
    saveLatencyMs: 240, // simulasi I/O agar proteksi race condition terlihat
    toastDurationMs: 4600,
    draftDebounceMs: 350,
  });

  const STORAGE_KEYS = Object.freeze({
    logs: 'damara.logs.v1',
    session: 'damara.session.v1',
    draft: 'damara.draft.v1',
    revision: 'damara.revision.v1',
  });

  const STATUS_OPTIONS = Object.freeze({
    hadir: { label: 'Hadir' },
    izin: { label: 'Izin' },
    sakit: { label: 'Sakit' },
    cuti: { label: 'Cuti' },
    dinas: { label: 'Dinas Luar' },
  });

  const NOTIFICATION_LABEL = Object.freeze({
    success: 'Berhasil',
    warning: 'Peringatan',
    error: 'Kesalahan',
    info: 'Informasi',
  });

  /* ==========================================================
   * 2. UTILITAS UMUM
   * ========================================================== */
  const byId = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  /** ID unik sederhana: komponen waktu + entropi acak. */
  function generateId() {
    return `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Membersihkan karakter kontrol dan membatasi panjang teks. */
  function sanitizeText(value, maxLength) {
    return String(value ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .slice(0, maxLength);
  }

  /** Mengubah entitas log menjadi objek murni untuk serialisasi. */
  function toPlainLog(log) {
    return {
      id: log.id,
      technicianName: log.technicianName,
      status: log.status,
      jobDesc: log.jobDesc,
      timestamp: log.timestamp,
    };
  }

  const dateTimeFormatter = new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  function formatDateTime(isoString) {
    const date = new Date(isoString);
    return Number.isNaN(date.getTime()) ? 'Waktu tidak diketahui' : dateTimeFormatter.format(date);
  }

  function formatRelative(isoString) {
    const time = new Date(isoString).getTime();
    if (!Number.isFinite(time)) return '';
    const diff = Math.max(0, Date.now() - time);
    if (diff < 45_000) return 'baru saja';
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `${minutes} menit lalu`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} jam lalu`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} hari lalu`;
    return 'lebih dari sepekan';
  }

  function initialsOf(name) {
    return (
      sanitizeText(name, CONFIG.nameLimit)
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join('') || '?'
    );
  }

  const byNewest = (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();

  /* ==========================================================
   * 3. EVENT BUS (mediator antar lapisan MVVM)
   * ========================================================== */
  class EventBus {
    #listeners = new Map();

    on(eventName, handler) {
      if (!this.#listeners.has(eventName)) this.#listeners.set(eventName, new Set());
      this.#listeners.get(eventName).add(handler);
      return () => this.off(eventName, handler);
    }

    off(eventName, handler) {
      this.#listeners.get(eventName)?.delete(handler);
    }

    emit(eventName, payload) {
      const handlers = this.#listeners.get(eventName);
      if (!handlers) return;
      for (const handler of [...handlers]) {
        try {
          handler(payload);
        } catch (error) {
          console.error(`[EventBus] Handler "${eventName}" gagal:`, error);
        }
      }
    }
  }

  /* ==========================================================
   * 4. OBSERVABLE PROXY (inti reaktivitas ViewModel)
   *    Setiap mutasi state dikumpulkan lalu di-flush sekali per
   *    microtask, sehingga UI tidak dirender berulang-ulang.
   * ========================================================== */
  function createObservable(target, onBatch) {
    const proxyCache = new WeakMap();
    let queue = [];
    let scheduled = false;

    function flush() {
      scheduled = false;
      const changes = queue;
      queue = [];
      if (changes.length) onBatch(changes);
    }

    function schedule(change) {
      queue.push(change);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    }

    function wrap(value, path) {
      if (value === null || typeof value !== 'object') return value;
      if (proxyCache.has(value)) return proxyCache.get(value);

      const proxy = new Proxy(value, {
        get(obj, property, receiver) {
          const result = Reflect.get(obj, property, receiver);
          return wrap(result, `${path}${String(property)}.`);
        },
        set(obj, property, nextValue, receiver) {
          const previous = obj[property];
          if (Object.is(previous, nextValue)) return true;
          const applied = Reflect.set(obj, property, nextValue, receiver);
          if (applied) {
            schedule({ path: `${path}${String(property)}`, value: nextValue, previous });
          }
          return applied;
        },
        deleteProperty(obj, property) {
          const hadKey = Object.prototype.hasOwnProperty.call(obj, property);
          const previous = obj[property];
          const deleted = Reflect.deleteProperty(obj, property);
          if (deleted && hadKey) {
            schedule({ path: `${path}${String(property)}`, value: undefined, previous });
          }
          return deleted;
        },
      });

      proxyCache.set(value, proxy);
      return proxy;
    }

    return wrap(target, '');
  }

  /* ==========================================================
   * 5. STORAGE SERVICE (localStorage + defensive programming)
   * ========================================================== */
  class StorageService {
    #bus;
    #available = false;
    #quotaOnce = false;

    constructor(bus) {
      this.#bus = bus;
      this.#available = this.#probe();
    }

    get available() {
      return this.#available;
    }

    /** Uji tulis/hapus untuk mendeteksi mode privat atau storage diblokir. */
    #probe() {
      try {
        const probeKey = `__damara_probe_${Date.now()}`;
        window.localStorage.setItem(probeKey, '1');
        window.localStorage.removeItem(probeKey);
        return true;
      } catch (error) {
        this.#bus.emit('storage:unavailable', { error });
        return false;
      }
    }

    /** Membaca JSON dengan try-catch; data korup dikarantina. */
    readJSON(key, fallback) {
      if (!this.#available) return fallback;

      let raw = null;
      try {
        raw = window.localStorage.getItem(key);
      } catch (error) {
        this.#bus.emit('storage:error', { key, error });
        return fallback;
      }

      if (raw === null || raw === '') return fallback;

      try {
        return JSON.parse(raw);
      } catch (error) {
        this.#quarantine(key, raw);
        this.#bus.emit('storage:corrupt', { key, error });
        return fallback;
      }
    }

    /** Menulis JSON dengan try-catch; simulasi kuota hanya untuk write non-draf. */
    writeJSON(key, value, { allowQuotaSimulation = true } = {}) {
      if (!this.#available) {
        this.#bus.emit('storage:unavailable', { key });
        return false;
      }

      if (allowQuotaSimulation && this.#quotaOnce) {
        this.#quotaOnce = false;
        const error = new Error('Simulasi QuotaExceededError: ruang penyimpanan penuh.');
        error.name = 'QuotaExceededError';
        this.#bus.emit('storage:quota', { key, error });
        return false;
      }

      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        const isQuota =
          error?.name === 'QuotaExceededError' ||
          error?.code === 22 ||
          error?.code === 1014;
        this.#bus.emit(isQuota ? 'storage:quota' : 'storage:error', { key, error });
        return false;
      }
    }

    remove(key) {
      if (!this.#available) return;
      try {
        window.localStorage.removeItem(key);
      } catch (error) {
        this.#bus.emit('storage:error', { key, error });
      }
    }

    /** Mengaktifkan kegagalan kuota sekali pakai untuk pengujian. */
    armQuotaSimulation() {
      if (!this.#available) return false;
      this.#quotaOnce = true;
      return true;
    }

    /** Menulis JSON sengaja rusak untuk menguji jalur pemulihan. */
    corruptForTesting(key) {
      if (!this.#available) return false;
      try {
        window.localStorage.setItem(key, '{"logs": [ {"id": "rusak"');
        return true;
      } catch (error) {
        this.#bus.emit('storage:error', { key, error });
        return false;
      }
    }

    /** Menyimpan salinan data mentah yang gagal di-parse. */
    #quarantine(key, rawValue) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        window.localStorage.setItem(`${key}.corrupt.${stamp}`, rawValue.slice(0, 50_000));
      } catch {
        /* Arsip opsional: jika kuota penuh, lanjutkan pemulihan. */
      }
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* Abaikan: data tetap akan ditimpa saat penulisan berikutnya. */
      }
    }
  }

  /* ==========================================================
   * 6. NORMALISASI MODEL
   * ========================================================== */
  function normalizeLogs(candidate) {
    if (!Array.isArray(candidate)) return [];

    const unique = new Map();
    for (const item of candidate) {
      if (!item || typeof item !== 'object') continue;

      const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : generateId();
      if (unique.has(id)) continue;

      const technicianName = sanitizeText(item.technicianName, CONFIG.nameLimit).trim();
      const jobDesc = sanitizeText(item.jobDesc, CONFIG.descLimit).trim();
      const status = Object.prototype.hasOwnProperty.call(STATUS_OPTIONS, item.status)
        ? item.status
        : '';
      const parsedDate = new Date(item.timestamp);
      const timestamp = Number.isNaN(parsedDate.getTime())
        ? new Date().toISOString()
        : parsedDate.toISOString();

      if (!technicianName || !jobDesc || !status) continue;

      unique.set(id, { id, technicianName, status, jobDesc, timestamp });
    }

    return [...unique.values()].sort(byNewest).slice(0, CONFIG.maxLogs);
  }

  function normalizeSession(candidate) {
    const fallback = { technicianName: '', active: false, updatedAt: null };
    if (!candidate || typeof candidate !== 'object') return fallback;

    const technicianName = sanitizeText(candidate.technicianName, CONFIG.nameLimit).trim();
    if (!technicianName) return fallback;

    return {
      technicianName,
      active: true,
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : null,
    };
  }

  function normalizeDraft(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;

    const technicianName = sanitizeText(candidate.technicianName, CONFIG.nameLimit);
    const jobDesc = sanitizeText(candidate.jobDesc, CONFIG.descLimit);
    const status = Object.prototype.hasOwnProperty.call(STATUS_OPTIONS, candidate.status)
      ? candidate.status
      : '';

    if (!technicianName.trim() && !jobDesc.trim() && !status) return null;

    return {
      technicianName,
      status,
      jobDesc,
      savedAt: typeof candidate.savedAt === 'string' ? candidate.savedAt : null,
    };
  }

  function mergeLogs(localLogs, remoteLogs) {
    const merged = new Map();
    for (const log of remoteLogs) merged.set(log.id, log);
    for (const log of localLogs) merged.set(log.id, log); // data lokal diprioritaskan
    return [...merged.values()].sort(byNewest).slice(0, CONFIG.maxLogs);
  }

  /* ==========================================================
   * 7. STATE + VIEWMODEL
   * ========================================================== */
  const bus = new EventBus();
  const storage = new StorageService(bus);

  // State mentah adalah sumber kebenaran; Proxy menjadi jalur mutasi reaktif.
  const rawState = {
    logs: [],
    revision: 0,
    session: { technicianName: '', active: false, updatedAt: null },
    form: { technicianName: '', status: '', jobDesc: '' },
    ui: {
      ready: false,
      saving: false,
      storage: 'unknown',
      lastSavedAt: null,
      draftSavedAt: null,
    },
  };

  const state = createObservable(rawState, (changes) => bus.emit('state:change', changes));

  let draftTimer = 0;
  let submissionToken = 0;

  /** Helper notifikasi terpusat. */
  function notify(type, title, message, duration) {
    bus.emit('notify', {
      type,
      title: title || NOTIFICATION_LABEL[type] || 'Informasi',
      message: message || '',
      duration: Number.isFinite(duration) ? duration : CONFIG.toastDurationMs,
    });
  }

  function readRevision() {
    const parsed = storage.readJSON(STORAGE_KEYS.revision, 0);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  }

  /**
   * Persistensi utama dengan deteksi race condition berbasis revisi.
   * Jika tab lain menulis lebih dulu, data digabungkan (bukan ditimpa).
   */
  function persistState() {
    if (!storage.available) {
      state.ui.storage = 'unavailable';
      return false;
    }

    try {
      const storedRevision = readRevision();
      let baseRevision = rawState.revision;

      if (storedRevision > rawState.revision) {
        const remoteLogs = normalizeLogs(storage.readJSON(STORAGE_KEYS.logs, []));
        const merged = mergeLogs(rawState.logs, remoteLogs);

        state.logs = merged; // Proxy memicu render ulang feed
        state.revision = storedRevision;
        baseRevision = storedRevision;

        notify(
          'warning',
          'Race condition terdeteksi',
          'Ada penulisan dari sesi lain. Riwayat digabungkan otomatis agar tidak ada data hilang.'
        );
      }

      const payload = rawState.logs.map(toPlainLog);
      if (!storage.writeJSON(STORAGE_KEYS.logs, payload)) return false;

      const nextRevision = Math.max(storedRevision, baseRevision) + 1;
      storage.writeJSON(STORAGE_KEYS.revision, nextRevision);
      state.revision = nextRevision;
      state.ui.storage = 'ready';
      state.ui.lastSavedAt = Date.now();

      // Sesi teknisi aktif ikut dipersistenkan agar pulih setelah refresh.
      if (rawState.session.active) {
        storage.writeJSON(STORAGE_KEYS.session, rawState.session);
      } else {
        storage.remove(STORAGE_KEYS.session);
      }
      return true;
    } catch (error) {
      console.error('[Persist] Gagal menyimpan state:', error);
      notify('error', 'Gagal menyimpan', `Kesalahan tak terduga: ${error.message}`);
      return false;
    }
  }

  /** Sinkronisasi antar tab melalui event "storage" milik peramban. */
  function handleStorageEvent(event) {
    if (!event.key) return;

    try {
      if (event.key === STORAGE_KEYS.logs) {
        const remoteLogs = normalizeLogs(event.newValue ? JSON.parse(event.newValue) : []);
        const merged = mergeLogs(rawState.logs, remoteLogs);
        const changed =
          merged.length !== rawState.logs.length ||
          merged.some((log, index) => log.id !== rawState.logs[index]?.id);

        if (changed) {
          state.logs = merged;
          state.revision = readRevision();
          notify('info', 'Tersinkronisasi', 'Riwayat kegiatan diperbarui dari tab atau perangkat lain.');
        }
      } else if (event.key === STORAGE_KEYS.session) {
        const session = normalizeSession(event.newValue ? JSON.parse(event.newValue) : null);
        if (session.active && session.technicianName !== rawState.session.technicianName) {
          state.session = session;
          notify('info', 'Sesi diperbarui', `Sesi aktif sekarang: ${session.technicianName}.`);
        }
      }
    } catch (error) {
      console.warn('[Storage] Event lintas tab tidak dapat diproses:', error);
    }
  }

  /** Menyimpan draf formulir secara debounce agar tidak menulis tiap ketukan. */
  function scheduleDraftSave() {
    window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(saveDraft, CONFIG.draftDebounceMs);
  }

  function saveDraft() {
    if (!storage.available) return;

    const { technicianName, status, jobDesc } = rawState.form;
    if (!technicianName.trim() && !status && !jobDesc.trim()) {
      storage.remove(STORAGE_KEYS.draft);
      state.ui.draftSavedAt = null;
      return;
    }

    const savedAt = new Date().toISOString();
    const success = storage.writeJSON(
      STORAGE_KEYS.draft,
      { technicianName, status, jobDesc, savedAt },
      { allowQuotaSimulation: false }
    );

    if (success) state.ui.draftSavedAt = Date.parse(savedAt);
  }

  /** Validasi terpusat; mengembalikan nilai yang sudah disanitasi. */
  function validateForm(form) {
    const errors = {};
    const technicianName = sanitizeText(form.technicianName, CONFIG.nameLimit)
      .trim()
      .replace(/\s+/g, ' ');
    const jobDesc = sanitizeText(form.jobDesc, CONFIG.descLimit).trim();
    const status = Object.prototype.hasOwnProperty.call(STATUS_OPTIONS, form.status)
      ? form.status
      : '';

    if (technicianName.length < CONFIG.minNameLength) {
      errors.technicianName = 'Nama teknisi minimal 3 karakter.';
    }
    if (!status) {
      errors.status = 'Pilih status kehadiran terlebih dahulu.';
    }
    if (jobDesc.length < CONFIG.minDescLength) {
      errors.jobDesc = 'Log pekerjaan minimal 5 karakter.';
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors,
      values: { technicianName, status, jobDesc },
    };
  }

  const viewModel = {
    state,

    /** Inisialisasi: pulihkan sesi, draf, dan riwayat dari localStorage. */
    init() {
      this.bindStorageEvents();

      const draft = normalizeDraft(storage.readJSON(STORAGE_KEYS.draft, null));
      const session = normalizeSession(storage.readJSON(STORAGE_KEYS.session, null));
      const logs = normalizeLogs(storage.readJSON(STORAGE_KEYS.logs, []));

      state.logs = logs;
      state.revision = readRevision();
      state.session = session;
      state.form = {
        technicianName: draft?.technicianName || session.technicianName,
        status: draft?.status || '',
        jobDesc: draft?.jobDesc || '',
      };
      state.ui.storage = storage.available ? 'ready' : 'unavailable';
      state.ui.draftSavedAt = draft?.savedAt ? Date.parse(draft.savedAt) : null;
      state.ui.ready = true;

      bus.emit('app:ready');

      if (!storage.available) {
        notify(
          'error',
          'Penyimpanan tidak tersedia',
          'Log tetap dapat dicatat, tetapi tidak bertahan setelah halaman dimuat ulang.',
          7000
        );
      } else if (draft) {
        notify('info', 'Draf dipulihkan', 'Isian formulir terakhir berhasil dimuat kembali.');
      }
    },

    /** Two-way binding: View mengirim perubahan, Proxy memicu render balik. */
    setField(field, value) {
      if (!Object.prototype.hasOwnProperty.call(rawState.form, field)) return;

      const limits = { technicianName: CONFIG.nameLimit, status: 32, jobDesc: CONFIG.descLimit };
      const limit = limits[field] ?? 100;
      const safeValue =
        field === 'status'
          ? (Object.prototype.hasOwnProperty.call(STATUS_OPTIONS, value) ? value : '')
          : sanitizeText(value, limit);

      if (rawState.form[field] === safeValue) return;

      state.form[field] = safeValue;
      scheduleDraftSave();
    },

    /** Aksi utama form: validasi, simpan reaktif, lalu persist. */
    async submit() {
      // Guard 1: cegah pengiriman ganda (double-tap / race condition).
      if (rawState.ui.saving) {
        notify('warning', 'Masih memproses', 'Permintaan sebelumnya belum selesai. Tunggu sebentar.');
        return;
      }

      const { valid, errors, values } = validateForm(rawState.form);
      if (!valid) {
        bus.emit('form:invalid', errors);
        notify('error', 'Formulir belum lengkap', 'Periksa kembali kolom yang ditandai merah.');
        return;
      }

      const token = ++submissionToken;
      state.ui.saving = true;

      try {
        // Simulasi I/O asinkron: memberi jendela untuk menguji guard race condition.
        await sleep(CONFIG.saveLatencyMs);

        // Guard 2: abaikan hasil usang jika ada proses yang lebih baru.
        if (token !== submissionToken) {
          notify('warning', 'Pengiriman dibatalkan', 'Ada proses pengiriman lain yang lebih baru.');
          return;
        }

        const entry = {
          id: generateId(),
          technicianName: values.technicianName,
          status: values.status,
          jobDesc: values.jobDesc,
          timestamp: new Date().toISOString(),
        };

        const droppedOldest = rawState.logs.length + 1 > CONFIG.maxLogs;

        // Mutasi lewat Proxy -> UI otomatis dirender ulang.
        state.logs = [entry, ...rawState.logs].slice(0, CONFIG.maxLogs);
        state.session = {
          technicianName: entry.technicianName,
          active: true,
          updatedAt: entry.timestamp,
        };
        state.form = { technicianName: entry.technicianName, status: '', jobDesc: '' };
        state.ui.draftSavedAt = null;

        window.clearTimeout(draftTimer);
        storage.remove(STORAGE_KEYS.draft);

        const saved = persistState();
        if (saved) {
          notify(
            'success',
            'Log terkirim',
            `Kegiatan "${STATUS_OPTIONS[entry.status].label}" dari ${entry.technicianName} tersimpan.`
          );
          if (droppedOldest) {
            notify('info', 'Arsip dibatasi', `Hanya ${CONFIG.maxLogs} log terbaru yang dipertahankan.`);
          }
        }

        bus.emit('form:reset');
      } catch (error) {
        console.error('[Submit] Gagal mengirim log:', error);
        notify('error', 'Gagal mengirim log', error?.message || 'Terjadi kesalahan tak terduga.');
      } finally {
        if (token === submissionToken) state.ui.saving = false;
      }
    },

    /** Menghapus satu log (delegasi event dari kartu). */
    removeLog(id) {
      const target = rawState.logs.find((log) => log.id === id);
      if (!target) {
        notify('warning', 'Log tidak ditemukan', 'Mungkin sudah dihapus dari tab lain.');
        return;
      }

      state.logs = rawState.logs.filter((log) => log.id !== id);
      const saved = persistState();

      notify(
        saved ? 'success' : 'warning',
        'Log dihapus',
        saved
          ? `Log dari ${target.technicianName} telah dihapus permanen.`
          : 'Log dihapus dari tampilan, tetapi penyimpanan gagal diperbarui.'
      );
    },

    /** Mengosongkan seluruh riwayat dengan konfirmasi dua langkah di View. */
    clearLogs() {
      const total = rawState.logs.length;
      if (!total) return;

      state.logs = [];
      const saved = persistState();

      notify(
        saved ? 'success' : 'warning',
        'Riwayat dibersihkan',
        saved
          ? `${total} log dihapus dari perangkat ini.`
          : `${total} log dihapus dari tampilan; penyimpanan gagal diperbarui.`
      );
    },

    /** Percobaan simpan ulang manual setelah kegagalan penyimpanan. */
    persist() {
      const saved = persistState();
      if (saved) {
        notify('success', 'Berhasil disimpan', 'Data terbaru sudah tersimpan di perangkat.');
      }
      return saved;
    },

    /** Mengakhiri sesi teknisi tanpa menghapus riwayat. */
    endSession() {
      if (!rawState.session.active) return;

      const name = rawState.session.technicianName;
      storage.remove(STORAGE_KEYS.session);
      state.session = { technicianName: '', active: false, updatedAt: null };

      if (rawState.form.technicianName === name) {
        state.form.technicianName = '';
        scheduleDraftSave();
      }

      notify('info', 'Sesi diakhiri', `Sesi ${name} ditutup. Riwayat log tetap tersimpan.`);
    },

    /* ---------------- Panel uji ketahanan ---------------- */

    simulateQuota() {
      if (!storage.armQuotaSimulation()) {
        notify('error', 'Simulasi tidak tersedia', 'localStorage tidak dapat diakses pada peramban ini.');
        return;
      }
      notify(
        'warning',
        'Kuota penuh disimulasikan',
        'Tekan "Kirim" untuk melihat penanganan QuotaExceededError. Log tidak akan hilang dari memori.',
        7000
      );
    },

    simulateCorruption() {
      if (!storage.available) {
        notify('error', 'Simulasi tidak tersedia', 'localStorage tidak dapat diakses pada peramban ini.');
        return;
      }

      if (!storage.corruptForTesting(STORAGE_KEYS.logs)) {
        notify('error', 'Simulasi gagal', 'Tidak dapat menulis data uji ke penyimpanan.');
        return;
      }

      storage.readJSON(STORAGE_KEYS.logs, []); // memicu deteksi korup + karantina
      const healed = persistState();          // tulis ulang data valid dari memori

      notify(
        healed ? 'success' : 'error',
        healed ? 'Penyimpanan dipulihkan' : 'Pemulihan gagal',
        healed
          ? 'JSON rusak telah diarsipkan dan data valid ditulis ulang.'
          : 'Data valid gagal ditulis ulang. Coba lagi lewat tombol simpan.'
      );
    },

    simulateRace() {
      if (!storage.available) {
        notify('error', 'Simulasi tidak tersedia', 'localStorage tidak dapat diakses pada peramban ini.');
        return;
      }

      const ghost = {
        id: generateId(),
        technicianName: 'Teknisi Cabang',
        status: 'hadir',
        jobDesc: 'Entri dari perangkat lain — dibuat untuk menguji penggabungan data (race condition).',
        timestamp: new Date().toISOString(),
      };

      const remotePayload = [...rawState.logs, ghost]
        .sort(byNewest)
        .slice(0, CONFIG.maxLogs)
        .map(toPlainLog);

      if (!storage.writeJSON(STORAGE_KEYS.logs, remotePayload)) {
        notify('error', 'Simulasi gagal', 'Penulisan data tiruan ditolak penyimpanan.');
        return;
      }

      // Naikkan revisi di storage, tetapi state lokal sengaja dibiarkan usang.
      storage.writeJSON(STORAGE_KEYS.revision, readRevision() + 1);

      const saved = persistState();
      if (!saved) {
        notify('error', 'Simulasi race gagal', 'Penyimpanan menolak proses penggabungan.');
      }
    },

    /** Menerjemahkan kejadian storage menjadi state UI + notifikasi. */
    bindStorageEvents() {
      bus.on('storage:quota', () => {
        state.ui.storage = 'quota';
        notify(
          'error',
          'Penyimpanan penuh',
          'Kuota localStorage habis. Log tetap aman di memori — hapus beberapa log lalu tekan "Coba simpan".',
          7500
        );
      });

      bus.on('storage:error', (payload) => {
        state.ui.storage = 'error';
        notify(
          'error',
          'Penyimpanan gagal',
          `Tidak dapat menulis "${payload?.key ?? 'data'}": ${payload?.error?.message ?? 'kesalahan tidak diketahui'}.`,
          7500
        );
      });

      bus.on('storage:unavailable', () => {
        state.ui.storage = 'unavailable';
      });

      bus.on('storage:corrupt', (payload) => {
        notify(
          'warning',
          'Data JSON rusak',
          `Data pada "${payload?.key ?? 'penyimpanan'}" tidak dapat dibaca. Salinan mentahnya diarsipkan otomatis.`,
          8000
        );
      });
    },
  };

  /* ==========================================================
   * 8. VIEW (manipulasi DOM + keyed rendering)
   * ========================================================== */
  function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const view = {
    els: {},
    cardNodes: new Map(),
    clearArmed: false,
    clearTimer: 0,
    relativeTimer: 0,

    init() {
      this.cacheElements();
      this.bindEvents();
      this.subscribe();
      this.relativeTimer = window.setInterval(() => this.refreshRelativeTimes(), 60_000);
    },

    /** Referensi DOM diambil sekali agar render berikutnya murah. */
    cacheElements() {
      this.els = {
        form: byId('log-form'),
        technicianName: byId('technicianName'),
        status: byId('status'),
        jobDesc: byId('jobDesc'),
        submitButton: byId('submit-btn'),
        submitLabel: byId('submit-label'),
        feed: byId('feed-container'),
        emptyState: byId('empty-state'),
        logCount: byId('log-count'),
        clearButton: byId('clear-btn'),
        sessionChip: byId('session-chip'),
        sessionLabel: byId('session-label'),
        endSessionButton: byId('end-session'),
        toastRegion: byId('toast-region'),
        storageAlert: byId('storage-alert'),
        storageAlertText: byId('storage-alert-text'),
        retrySave: byId('retry-save'),
        descCount: byId('desc-count'),
        draftStatus: byId('draft-status'),
        diagnostics: byId('diagnostics'),
      };
    },

    bindEvents() {
      const { form } = this.els;

      // Cegah reload peramban, lalu delegasikan ke ViewModel.
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void viewModel.submit();
      });

      // Two-way binding: input -> state (Proxy) -> sinkron balik oleh syncForm.
      form.addEventListener('input', (event) => {
        const field = event.target?.name;
        if (!field) return;
        viewModel.setField(field, event.target.value);
        this.clearFieldError(field);
      });

      form.addEventListener('change', (event) => {
        const field = event.target?.name;
        if (field === 'status') viewModel.setField(field, event.target.value);
      });

      this.els.clearButton.addEventListener('click', () => this.handleClearClick());
      this.els.endSessionButton.addEventListener('click', () => viewModel.endSession());
      this.els.retrySave.addEventListener('click', () => viewModel.persist());

      // Delegasi event untuk tombol hapus pada kartu (hemat listener).
      this.els.feed.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const trigger = target?.closest('[data-action="delete"]');
        if (!trigger) return;
        const card = trigger.closest('.log-card');
        if (card) viewModel.removeLog(card.dataset.id);
      });

      this.els.diagnostics?.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const trigger = target?.closest('[data-simulate]');
        if (!trigger) return;

        const action = trigger.dataset.simulate;
        if (action === 'quota') viewModel.simulateQuota();
        if (action === 'corrupt') viewModel.simulateCorruption();
        if (action === 'race') viewModel.simulateRace();
      });

      window.addEventListener('pagehide', () => window.clearInterval(this.relativeTimer));
    },

    subscribe() {
      bus.on('state:change', (changes) => this.applyChanges(changes));
      bus.on('app:ready', () => this.renderAll());
      bus.on('notify', (payload) => this.showToast(payload));
      bus.on('form:invalid', (errors) => this.showFieldErrors(errors));
      bus.on('form:reset', () => this.clearAllFieldErrors());
    },

    /** Render selektif berdasarkan akar path yang berubah. */
    applyChanges(changes) {
      const roots = new Set();
      for (const change of changes) roots.add(String(change.path).split('.')[0]);

      if (roots.has('logs')) this.renderFeed();
      if (roots.has('session')) this.renderSession();
      if (roots.has('form')) this.syncForm();
      if (roots.has('ui')) this.renderUiState();
    },

    renderAll() {
      this.renderFeed();
      this.renderSession();
      this.syncForm();
      this.renderUiState();
      this.clearAllFieldErrors();
    },

    /* ---------------- Render feed dengan keyed nodes ---------------- */
    renderFeed() {
      const logs = rawState.logs;
      const seen = new Set();
      const fragment = document.createDocumentFragment();

      for (const log of logs) {
        seen.add(log.id);
        let node = this.cardNodes.get(log.id);

        if (!node) {
          node = this.createCard(log);
          this.cardNodes.set(log.id, node);
        } else {
          this.updateCard(node, log);
        }

        fragment.append(node);
      }

      // Bersihkan node yang datanya sudah tidak ada.
      for (const [id, node] of this.cardNodes) {
        if (!seen.has(id)) {
          node.remove();
          this.cardNodes.delete(id);
        }
      }

      // Node lama dipindahkan, bukan dibuat ulang (hemat reflow).
      this.els.feed.append(fragment);
      this.els.feed.hidden = logs.length === 0;
      this.els.emptyState.hidden = logs.length > 0;
      this.els.logCount.textContent = String(logs.length);
      this.els.logCount.setAttribute('aria-label', `${logs.length} log kegiatan`);
      this.els.clearButton.hidden = logs.length === 0;

      if (logs.length === 0) this.resetClearButton();
    },

    createCard(log) {
      const card = createElement('article', 'log-card');
      card.dataset.id = log.id;
      card.dataset.status = log.status;

      const head = createElement('div', 'log-card__head');
      const who = createElement('div', 'log-card__who');

      const avatar = createElement('span', 'avatar', initialsOf(log.technicianName));
      avatar.setAttribute('aria-hidden', 'true');

      const meta = createElement('div', 'log-card__meta');
      const name = createElement('h3', 'log-card__name', log.technicianName);

      const timeRow = createElement('p', 'log-card__time');
      const timeEl = document.createElement('time');
      timeEl.dateTime = log.timestamp;
      timeEl.textContent = formatDateTime(log.timestamp);

      const dot = createElement('span', 'dot', '•');
      dot.setAttribute('aria-hidden', 'true');

      const relative = createElement('span', 'relative', formatRelative(log.timestamp));
      timeRow.append(timeEl, dot, relative);
      meta.append(name, timeRow);
      who.append(avatar, meta);

      const status = createElement(
        'span',
        'status-pill',
        STATUS_OPTIONS[log.status]?.label ?? log.status
      );
      head.append(who, status);

      const desc = createElement('p', 'log-card__desc', log.jobDesc);

      const foot = createElement('div', 'log-card__foot');
      const idEl = createElement('span', 'log-card__id', `#${log.id.slice(-6).toUpperCase()}`);
      const deleteButton = createElement('button', 'btn-delete', 'Hapus');
      deleteButton.type = 'button';
      deleteButton.dataset.action = 'delete';
      deleteButton.setAttribute('aria-label', `Hapus log ${log.technicianName}`);
      foot.append(idEl, deleteButton);

      card.append(head, desc, foot);
      card._refs = { avatar, name, timeEl, relative, status, desc, deleteButton };

      return card;
    },

    updateCard(card, log) {
      const refs = card._refs;
      if (!refs) return;

      card.dataset.status = log.status;
      const statusLabel = STATUS_OPTIONS[log.status]?.label ?? log.status;
      if (refs.status.textContent !== statusLabel) refs.status.textContent = statusLabel;

      if (refs.name.textContent !== log.technicianName) {
        refs.name.textContent = log.technicianName;
        refs.avatar.textContent = initialsOf(log.technicianName);
        refs.deleteButton.setAttribute('aria-label', `Hapus log ${log.technicianName}`);
      }

      const timeLabel = formatDateTime(log.timestamp);
      if (refs.timeEl.textContent !== timeLabel) refs.timeEl.textContent = timeLabel;
      refs.timeEl.dateTime = log.timestamp;

      const relativeLabel = formatRelative(log.timestamp);
      if (refs.relative.textContent !== relativeLabel) refs.relative.textContent = relativeLabel;

      if (refs.desc.textContent !== log.jobDesc) refs.desc.textContent = log.jobDesc;
    },

    refreshRelativeTimes() {
      for (const log of rawState.logs) {
        const card = this.cardNodes.get(log.id);
        if (!card?._refs) continue;
        const label = formatRelative(log.timestamp);
        if (card._refs.relative.textContent !== label) card._refs.relative.textContent = label;
      }
    },

    /* ---------------- Header, form, dan status UI ---------------- */
    renderSession() {
      const { session } = rawState;
      const active = Boolean(session.active && session.technicianName);

      this.els.sessionChip.dataset.state = active ? 'active' : 'idle';
      this.els.sessionLabel.textContent = active
        ? `Sesi: ${session.technicianName}`
        : 'Belum ada sesi aktif';
      this.els.endSessionButton.hidden = !active;
    },

    syncForm() {
      const form = rawState.form;

      this.assignValue(this.els.technicianName, form.technicianName);
      this.assignValue(this.els.status, form.status);
      this.assignValue(this.els.jobDesc, form.jobDesc);

      const used = form.jobDesc.length;
      this.els.descCount.textContent = `${used}/${CONFIG.descLimit}`;
      this.els.descCount.classList.toggle('is-warning', used >= CONFIG.descLimit * 0.9);

      this.updateDraftStatus();
    },

    assignValue(element, value) {
      if (!element || element.value === value) return;
      element.value = value; // state -> view (tanpa mengganggu caret saat mengetik)
    },

    updateDraftStatus() {
      const savedAt = rawState.ui.draftSavedAt;
      this.els.draftStatus.textContent = savedAt
        ? `Draf tersimpan ${new Date(savedAt).toLocaleTimeString('id-ID', {
            hour: '2-digit',
            minute: '2-digit',
          })}`
        : 'Draf tersimpan otomatis di perangkat ini';
    },

    renderUiState() {
      const { saving } = rawState.ui;

      this.els.submitButton.disabled = saving;
      this.els.submitButton.classList.toggle('is-loading', saving);
      this.els.submitButton.setAttribute('aria-busy', String(saving));
      this.els.submitLabel.textContent = saving ? 'Menyimpan…' : 'Kirim';

      const alerts = {
        unavailable: {
          text: 'Penyimpanan lokal tidak tersedia (mis. mode privat). Log tetap bisa dicatat, tetapi tidak bertahan setelah halaman dimuat ulang.',
          retry: false,
        },
        quota: {
          text: 'Kuota penyimpanan penuh. Data terbaru masih aman di memori. Hapus beberapa log lama, lalu tekan "Coba simpan".',
          retry: true,
        },
        error: {
          text: 'Penyimpanan gagal diperbarui. Data masih aman di memori perangkat ini.',
          retry: true,
        },
      };

      const info = alerts[rawState.ui.storage];
      this.els.storageAlert.hidden = !info;
      this.els.retrySave.hidden = !info?.retry;
      if (info) this.els.storageAlertText.textContent = info.text;

      this.updateDraftStatus();
    },

    /* ---------------- Validasi inline ---------------- */
    showFieldErrors(errors) {
      this.clearAllFieldErrors();

      for (const [field, message] of Object.entries(errors)) {
        const input = this.els[field];
        const errorEl = document.querySelector(`[data-error-for="${field}"]`);
        if (!input || !errorEl) continue;

        errorEl.textContent = message;
        input.setAttribute('aria-invalid', 'true');
        input.closest('.field')?.classList.add('has-error');
      }

      const firstField = Object.keys(errors)[0];
      if (firstField) {
        window.requestAnimationFrame(() => this.els[firstField]?.focus());
      }
    },

    clearFieldError(field) {
      const input = this.els[field];
      const errorEl = document.querySelector(`[data-error-for="${field}"]`);
      if (!input || !errorEl) return;

      errorEl.textContent = '';
      input.removeAttribute('aria-invalid');
      input.closest('.field')?.classList.remove('has-error');
    },

    clearAllFieldErrors() {
      for (const field of ['technicianName', 'status', 'jobDesc']) {
        this.clearFieldError(field);
      }
    },

    /* ---------------- Konfirmasi hapus dua langkah ---------------- */
    handleClearClick() {
      const button = this.els.clearButton;

      if (!this.clearArmed) {
        this.clearArmed = true;
        button.classList.add('is-armed');
        button.textContent = 'Yakin? Tekan lagi';
        this.clearTimer = window.setTimeout(() => this.resetClearButton(), 3200);
        return;
      }

      this.resetClearButton();
      viewModel.clearLogs();
    },

    resetClearButton() {
      window.clearTimeout(this.clearTimer);
      this.clearArmed = false;
      const button = this.els.clearButton;
      if (!button) return;
      button.classList.remove('is-armed');
      button.textContent = 'Bersihkan';
    },

    /* ---------------- Toast notifikasi ---------------- */
    showToast({ type = 'info', title, message, duration = CONFIG.toastDurationMs } = {}) {
      const region = this.els.toastRegion;
      if (!region) return;

      while (region.children.length >= 2) region.firstElementChild?.remove();

      const toast = createElement('div', `toast toast--${type}`);
      if (type === 'error') toast.setAttribute('role', 'alert');

      const icon = createElement('span', 'toast__icon');
      icon.setAttribute('aria-hidden', 'true');

      const body = createElement('div', 'toast__body');
      body.append(
        createElement('strong', 'toast__title', title || NOTIFICATION_LABEL[type] || 'Informasi'),
        createElement('p', 'toast__message', message)
      );

      const close = createElement('button', 'toast__close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'Tutup notifikasi');

      toast.append(icon, body, close);
      region.append(toast);

      // Animasi masuk pada frame berikutnya.
      window.requestAnimationFrame(() => toast.classList.add('is-visible'));

      const dismiss = () => {
        if (!toast.isConnected) return;
        toast.classList.remove('is-visible');
        toast.classList.add('is-leaving');
        window.setTimeout(() => toast.remove(), 240);
      };

      const timer = window.setTimeout(dismiss, duration);
      close.addEventListener('click', () => {
        window.clearTimeout(timer);
        dismiss();
      });
    },
  };

  /* ==========================================================
   * 9. BOOTSTRAPPING
   * ========================================================== */
  function boot() {
    view.init();          // View berlangganan event lebih dulu
    viewModel.init();     // lalu state dipulihkan dan dirender
    window.addEventListener('storage', handleStorageEvent);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
