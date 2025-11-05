/**
 * Eagle API 모듈
 * Eagle 라이브러리와 상호작용하는 함수들
 */

/**
 * Eagle 라이브러리에 아이템 추가
 * @param {string} filePath - 파일 경로
 * @param {object} metadata - 아이템 메타데이터
 * @returns {Promise<object>} 추가된 아이템 객체
 */
async function addItemToLibrary(filePath, metadata) {
  try {
    const item = await eagle.item.addFromPath(filePath, metadata);
    console.log(`Added ${filePath} to Eagle library`, item);
    return item;
  } catch (error) {
    // 이미 존재하는 아이템인 경우 처리
    if (error.message && error.message.includes("Item already exists")) {
      console.log(`${filePath} already exists in Eagle library`);
      // URL로 아이템 검색 (website는 추가할 때 사용, 검색은 url 사용)
      if (metadata.website) {
        const items = await eagle.item.get({ url: metadata.website });
        if (items.length > 0) {
          return items[0]; // 첫 번째 일치 항목 반환
        }
      }
    }
    throw error; // 다른 오류는 그대로 전파
  }
}

/**
 * 폴더 생성 또는 기존 폴더 찾기
 * @param {string} folderName - 폴더 이름
 * @returns {Promise<object>} 폴더 객체 (ID 포함)
 */
async function createOrFindFolder(folderName) {
  try {
    // 새 폴더 생성 시도
    const newFolder = await eagle.folder.create({ name: folderName });
    return newFolder;
  } catch (error) {
    // 이미 존재하는 폴더인 경우
    if (error.message && error.message.includes("already exists")) {
      const folders = await eagle.folder.get();
      const existingFolder = folders.find(f => f.name === folderName);
      if (existingFolder) {
        return existingFolder;
      }
    }
    throw error; // 다른 오류는 그대로 전파
  }
}

/**
 * 아이템의 폴더 목록 업데이트
 * @param {string} itemId - 아이템 ID
 * @param {Array<string>} folderIds - 폴더 ID 배열
 * @returns {Promise<object>} 업데이트된 아이템 객체
 */
async function updateItemFolders(itemId, folderIds) {
  try {
    const updatedItem = await eagle.item.modify(itemId, { folders: folderIds });
    console.log(`Updated item ${itemId} folders`, updatedItem);
    return updatedItem;
  } catch (error) {
    console.error(`Failed to update item ${itemId} folders:`, error);
    throw error;
  }
}

/**
 * 아이템에 폴더 추가 (기존 폴더 유지)
 * @param {string} itemId - 아이템 ID (Eagle item ID)
 * @param {string} newFolderId - 추가할 폴더 ID
 * @returns {Promise<object>} 업데이트된 아이템 객체
 */
async function addFolderToItem(itemId, newFolderId) {
  try {
    // 현재 아이템 조회
    const item = await eagle.item.getById(itemId);
    if (!item) {
      throw new Error(`Item ${itemId} not found`);
    }
    
    // 폴더가 이미 있는지 확인
    const currentFolders = item.folders || [];
    if (currentFolders.includes(newFolderId)) {
      console.log(`Item ${itemId} already in folder ${newFolderId}`);
      return item;
    }
    
    // 새 폴더 추가
    const updatedFolders = [...currentFolders, newFolderId];
    item.folders = updatedFolders;
    await item.save();
    
    console.log(`✅ Added folder ${newFolderId} to item ${itemId} (total folders: ${updatedFolders.length})`);
    return item;
  } catch (error) {
    console.error(`❌ Failed to add folder to item ${itemId}:`, error);
    throw error;
  }
}

/**
 * 아이템의 태그 업데이트
 * @param {string} itemId - 아이템 ID
 * @param {Array<string>} tags - 태그 배열
 * @returns {Promise<object>} 업데이트된 아이템 객체
 */
async function updateItemTags(itemId, tags) {
  try {
    const updatedItem = await eagle.item.modify(itemId, { tags });
    console.log(`Updated item ${itemId} tags`, updatedItem);
    return updatedItem;
  } catch (error) {
    console.error(`Failed to update item ${itemId} tags:`, error);
    throw error;
  }
}

/**
 * 중복 아이템 확인
 * @param {string} url - 비디오 URL
 * @param {string} videoId - 비디오 ID
 * @returns {Promise<boolean>} 중복 여부
 */
async function isDuplicateItem(url, videoId) {
  try {
    // URL로 검색
    if (url) {
      const itemsByUrl = await eagle.item.get({ website: url });
      if (itemsByUrl.length > 0) {
        return true;
      }
    }
    
    // 비디오 ID로 검색 (태그)
    if (videoId) {
      const itemsByVideoId = await eagle.item.get({ tags: [`videoId:${videoId}`] });
      if (itemsByVideoId.length > 0) {
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error('Error checking for duplicate item:', error);
    return false; // 에러 발생 시 기본값으로 중복 아님 반환
  }
}

/**
 * 아이템 메타데이터 준비
 * @param {string} title - 비디오 제목
 * @param {string} url - 비디오 URL
 * @param {object} metadata - 비디오 메타데이터
 * @param {Array<string>} folderIds - 폴더 ID 배열
 * @returns {object} Eagle용 메타데이터 객체
 */
function prepareItemMetadata(title, url, metadata, folderIds = []) {
  const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  const hostname = isYouTube ? 'youtube.com' : new URL(url).hostname;
  
  return {
    name: title,
    website: url,
    annotation: `Upload Date: ${metadata.upload_date || 'N/A'}
Views: ${metadata.view_count || 'N/A'}
Duration: ${metadata.duration ? formatDuration(metadata.duration) : 'N/A'}`,
    tags: [
      `Platform: ${hostname}`,
      `Channel: ${metadata.uploader || metadata.channel || 'N/A'}`,
      metadata.playlist ? `Playlist: ${metadata.playlist}` : null,
      metadata.id ? `videoId:${metadata.id}` : null
    ].filter(Boolean), // null 값 제거
    folders: folderIds
  };
}

/**
 * 시간(초) 형식화
 * @param {number} seconds - 시간(초)
 * @returns {string} 형식화된 시간 문자열 (HH:MM:SS)
 */
function formatDuration(seconds) {
  if (!seconds) return 'N/A';
  
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts = [];
  if (hrs > 0) parts.push(`${hrs}h`);
  if (mins > 0 || hrs > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  
  return parts.join(' ');
}

/**
 * Eagle 라이브러리 정보 가져오기
 * @returns {Promise<object>} 라이브러리 정보
 */
async function getLibraryInfo() {
  return await eagle.library.info();
}

/**
 * Eagle 라이브러리 변경 이벤트 등록
 * @param {Function} callback - 라이브러리 경로를 받는 콜백
 */
function onLibraryChanged(callback) {
  eagle.onLibraryChanged(callback);
}

// 모듈 내보내기
module.exports = {
  addItemToLibrary,
  createOrFindFolder,
  updateItemFolders,
  addFolderToItem,
  updateItemTags,
  isDuplicateItem,
  prepareItemMetadata,
  formatDuration,
  getLibraryInfo,
  onLibraryChanged
}; 