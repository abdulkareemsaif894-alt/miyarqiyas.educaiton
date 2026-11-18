const TRAINING_FILE_NAME = "miyaar-qiyas-training.json";
const TRAINING_FILE_PROPERTY = "MIYAAR_TRAINING_FILE_ID";
const TRAINING_USER_PROPERTY = "MIYAAR_USER_KEY";
const MAX_TRAINING_STATE_LENGTH = 1000000;

function doGet() {
  return HtmlService.createHtmlOutputFromFile("index")
    .setTitle("معيار | خطة مذاكرة القدرات");
}

function getTrainingState() {
  const userKey = getUserKey_();
  const result = {
    userKey: userKey,
    email: Session.getActiveUser().getEmail() || "",
    record: null
  };
  let fileId = getTrainingFileId_();
  if (!fileId) return result;

  let response = fetchDrive_(
    "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?alt=media",
    "get"
  );
  if (response.getResponseCode() === 404) {
    PropertiesService.getUserProperties().deleteProperty(TRAINING_FILE_PROPERTY);
    fileId = findTrainingFileId_();
    if (!fileId) return result;
    response = fetchDrive_(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?alt=media",
      "get"
    );
  }
  requireSuccess_(response, "قراءة بيانات التدريب");

  let record;
  try {
    record = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error("ملف التدريب في Google Drive غير صالح.");
  }
  if (
    !record ||
    record.format !== "miyaar-qiyas-drive-v1" ||
    !record.state ||
    typeof record.state !== "object" ||
    Array.isArray(record.state)
  ) {
    throw new Error("ملف التدريب في Google Drive لا يحتوي على بيانات صالحة.");
  }
  result.record = record;
  return result;
}

function saveTrainingState(stateJson, writerId) {
  if (typeof stateJson !== "string" || stateJson.length > MAX_TRAINING_STATE_LENGTH) {
    throw new Error("حجم بيانات التدريب غير صالح.");
  }
  let state;
  try {
    state = JSON.parse(stateJson);
  } catch (error) {
    throw new Error("تعذر قراءة بيانات التدريب المرسلة.");
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("صيغة بيانات التدريب غير صالحة.");
  }

  const lock = LockService.getUserLock();
  if (!lock.tryLock(10000)) throw new Error("تعذر بدء حفظ البيانات الآن؛ حاول مجددًا.");
  try {
    const userKey = getUserKey_();
    const record = {
      format: "miyaar-qiyas-drive-v1",
      state: state,
      updatedAt: new Date().toISOString(),
      writerId: typeof writerId === "string" ? writerId.slice(0, 100) : ""
    };
    const recordJson = JSON.stringify(record);
    const properties = PropertiesService.getUserProperties();
    const fileId = getTrainingFileId_();
    let response;

    if (fileId) {
      response = fetchDrive_(
        "https://www.googleapis.com/upload/drive/v3/files/" + encodeURIComponent(fileId) + "?uploadType=media",
        "patch",
        recordJson,
        "application/json"
      );
      if (response.getResponseCode() === 404) {
        properties.deleteProperty(TRAINING_FILE_PROPERTY);
        fileId = null;
      }
    }
    if (!fileId) {
      const boundary = "miyaar_" + Utilities.getUuid().replace(/-/g, "");
      const metadata = {
        name: TRAINING_FILE_NAME,
        mimeType: "application/json",
        parents: ["appDataFolder"]
      };
      const payload =
        "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
        JSON.stringify(metadata) + "\r\n--" + boundary +
        "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
        recordJson + "\r\n--" + boundary + "--";
      response = fetchDrive_(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
        "post",
        payload,
        "multipart/related; boundary=" + boundary
      );
      requireSuccess_(response, "حفظ بيانات التدريب");
      const createdFile = JSON.parse(response.getContentText());
      if (!createdFile.id) throw new Error("لم يُرجع Google Drive معرف الملف.");
      properties.setProperty(TRAINING_FILE_PROPERTY, createdFile.id);
    }

    requireSuccess_(response, "حفظ بيانات التدريب");
    return { userKey: userKey, record: record };
  } finally {
    lock.releaseLock();
  }
}

function getUserKey_() {
  const properties = PropertiesService.getUserProperties();
  let userKey = properties.getProperty(TRAINING_USER_PROPERTY);
  if (!userKey) {
    userKey = Utilities.getUuid();
    properties.setProperty(TRAINING_USER_PROPERTY, userKey);
  }
  return userKey;
}

function getTrainingFileId_() {
  const properties = PropertiesService.getUserProperties();
  const cachedId = properties.getProperty(TRAINING_FILE_PROPERTY);
  return cachedId || findTrainingFileId_();
}

function findTrainingFileId_() {
  const query = "name = '" + TRAINING_FILE_NAME + "' and 'appDataFolder' in parents and trashed = false";
  const url = "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=" +
    encodeURIComponent(query) + "&fields=files(id,name)&pageSize=1";
  const response = fetchDrive_(url, "get");
  requireSuccess_(response, "البحث عن بيانات التدريب");
  const result = JSON.parse(response.getContentText());
  const file = result.files && result.files.length ? result.files[0] : null;
  if (file) PropertiesService.getUserProperties().setProperty(TRAINING_FILE_PROPERTY, file.id);
  return file ? file.id : null;
}

function fetchDrive_(url, method, payload, contentType) {
  const options = {
    method: method,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };
  if (payload !== undefined) {
    options.payload = payload;
    options.contentType = contentType || "application/json";
  }
  return UrlFetchApp.fetch(url, options);
}

function requireSuccess_(response, action) {
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    console.error("Google Drive " + action + " failed (" + status + "): " + response.getContentText());
    throw new Error("تعذر " + action + " في Google Drive (HTTP " + status + ").");
  }
}
