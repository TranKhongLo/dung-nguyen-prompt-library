(() => {
  const FAVORITE_KEY = "shareprompt_favorites_v2";
  const LEGACY_FAVORITE_KEY = "shareprompt_favorites";
  const COLLECTION_KEY = "shareprompt_collections_v1";

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "");
      return value ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function migrateFavorites() {
    const current = readJson(FAVORITE_KEY, null);
    if (Array.isArray(current)) return current.map(Number).filter(Number.isFinite);

    const legacy = readJson(LEGACY_FAVORITE_KEY, []);
    if (!Array.isArray(legacy)) return [];

    const migrated = [...new Set(legacy.map(Number).filter(Number.isFinite))];
    writeJson(FAVORITE_KEY, migrated);
    return migrated;
  }

  function getFavorites() {
    return migrateFavorites();
  }

  function setFavorites(ids) {
    const unique = [...new Set(ids.map(Number).filter(Number.isFinite))];
    writeJson(FAVORITE_KEY, unique);
    return unique;
  }

  function isFavorite(id) {
    return getFavorites().includes(Number(id));
  }

  function toggleFavorite(id) {
    const numericId = Number(id);
    const ids = getFavorites();
    const index = ids.indexOf(numericId);

    if (index >= 0) {
      ids.splice(index, 1);
      setFavorites(ids);
      return false;
    }

    ids.push(numericId);
    setFavorites(ids);
    return true;
  }

  function getCollections() {
    const raw = readJson(COLLECTION_KEY, []);
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((item) => item && item.id && item.name)
      .map((item) => ({
        id: String(item.id),
        name: String(item.name),
        createdAt: item.createdAt || new Date().toISOString(),
        promptIds: Array.isArray(item.promptIds)
          ? [...new Set(item.promptIds.map(Number).filter(Number.isFinite))]
          : []
      }));
  }

  function saveCollections(collections) {
    writeJson(COLLECTION_KEY, collections);
    return collections;
  }

  function createCollection(name) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Tên collection không được để trống.");

    const collections = getCollections();
    const duplicate = collections.find(
      (item) => item.name.toLowerCase() === cleanName.toLowerCase()
    );

    if (duplicate) return duplicate;

    if (collections.length >= 50) {
      throw new Error("Bạn đã đạt giới hạn 50 collections trên thiết bị này.");
    }

    const collection = {
      id: `col_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: cleanName,
      createdAt: new Date().toISOString(),
      promptIds: []
    };

    collections.push(collection);
    saveCollections(collections);
    return collection;
  }

  function renameCollection(id, name) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Tên collection không được để trống.");

    const collections = getCollections();
    const target = collections.find((item) => item.id === String(id));
    if (!target) throw new Error("Không tìm thấy collection.");

    const duplicate = collections.find(
      (item) =>
        item.id !== target.id &&
        item.name.toLowerCase() === cleanName.toLowerCase()
    );

    if (duplicate) throw new Error("Tên collection đã tồn tại.");

    target.name = cleanName;
    saveCollections(collections);
    return target;
  }

  function deleteCollection(id) {
    const collections = getCollections().filter(
      (item) => item.id !== String(id)
    );
    saveCollections(collections);
    return collections;
  }

  function promptInCollection(collectionId, promptId) {
    const collection = getCollections().find(
      (item) => item.id === String(collectionId)
    );
    if (!collection) return false;
    return collection.promptIds.includes(Number(promptId));
  }

  function setPromptInCollection(collectionId, promptId, enabled) {
    const collections = getCollections();
    const collection = collections.find(
      (item) => item.id === String(collectionId)
    );
    if (!collection) throw new Error("Không tìm thấy collection.");

    const numericId = Number(promptId);
    const index = collection.promptIds.indexOf(numericId);

    if (enabled && index < 0) {
      collection.promptIds.push(numericId);
    }

    if (!enabled && index >= 0) {
      collection.promptIds.splice(index, 1);
    }

    saveCollections(collections);
    return collection;
  }

  function collectionIdsForPrompt(promptId) {
    const numericId = Number(promptId);
    return getCollections()
      .filter((item) => item.promptIds.includes(numericId))
      .map((item) => item.id);
  }

  window.SharePromptStore = {
    getFavorites,
    setFavorites,
    isFavorite,
    toggleFavorite,
    getCollections,
    saveCollections,
    createCollection,
    renameCollection,
    deleteCollection,
    promptInCollection,
    setPromptInCollection,
    collectionIdsForPrompt
  };

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/service-worker.js")
        .catch(() => {});
    });
  }
})();
