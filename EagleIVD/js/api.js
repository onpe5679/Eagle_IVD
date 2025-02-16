// api.js

// Node 환경에서만 사용되는 모듈을 조건부로 로드
let path;
if (typeof window !== "undefined" && window.require) {
  path = window.require("path");
} else {
  // 브라우저에서는 필요 시 오류를 발생시키거나, dummy 객체를 제공할 수 있음
  console.warn("Node built-in modules not available; api.js functions may be limited.");
}

// Eagle API 호출 함수들
export async function addItemFromPath(filePath, options) {
  return await eagle.item.addFromPath(filePath, options);
}

export async function getItemsByUrl(url) {
  return await eagle.item.get({ url });
}

export async function modifyItem(itemId, modifications) {
  const items = await eagle.item.get({ id: itemId });
  if (items && items.length > 0) {
    let item = items[0];
    Object.assign(item, modifications);
    await item.save();
    return item;
  }
  throw new Error("Item not found");
}

export async function createFolder(folderName, description = "") {
  return await eagle.folder.create({ name: folderName, description });
}

export async function getFolderByName(folderName) {
  const folders = await eagle.folder.get({ keyword: folderName });
  return folders.find(folder => folder.name === folderName);
}

export async function addItemToFolder(itemId, folderId) {
  const items = await eagle.item.get({ id: itemId });
  if (items && items.length > 0) {
    let item = items[0];
    let folders = item.folders || [];
    if (!folders.includes(folderId)) {
      folders.push(folderId);
      item.folders = folders;
      await item.save();
    }
    return item;
  }
  throw new Error("Item not found");
}
