const subscriptionDb = require('./subscription-db');

/**
 * 라이브러리 내 중복 영상 처리를 담당하는 모듈
 */
class DuplicateHandler {
  constructor() {}

  /**
   * DB에서만 기존 다운로드된 영상인지 확인 (Eagle API 호출 제거)
   * @param {string} videoId - YouTube 영상 ID
   * @returns {Promise<Object|null>} 중복 정보 또는 null
   */
  async findExistingVideoInLibrary(videoId) {
    try {
      // subscription-db API 사용하여 중복 영상 찾기
      const existingVideos = await subscriptionDb.getVideosByVideoId(videoId);
      
      // 현재 라이브러리에서 완전 처리된 원본 영상만 찾기
      const originalRecord = existingVideos.find(video =>
        video.video_id === videoId &&
        video.is_duplicate === 0 &&
        video.downloaded === 1 &&
        video.eagle_linked === 1
      );

      if (!originalRecord) {
        console.log(`[DuplicateHandler] DB에서 영상을 찾을 수 없음: ${videoId}`);
        return null;
      }

      console.log(`[DuplicateHandler] DB에서 기존 영상 발견: ${videoId} (원본: ${originalRecord.title})`);
      
      return {
        dbRecordId: originalRecord.id,
        playlistId: originalRecord.playlist_id,
        title: originalRecord.title,
        videoId: originalRecord.video_id
      };
    } catch (error) {
      console.error(`[DuplicateHandler] DB 조회 오류 for ${videoId}:`, error);
      return null;
    }
  }

  /**
   * Eagle 아이템의 annotation을 스마트하게 업데이트
   * @param {string} existingAnnotation - 기존 annotation
   * @param {Object} updates - 업데이트할 정보
   * @returns {string} 업데이트된 annotation
   */
  updateAnnotationSection(existingAnnotation, updates) {
    let annotation = existingAnnotation || '';

    // First downloaded 업데이트/추가
    if (updates.firstDownloaded) {
      const regex = /First downloaded: [^\n]*/;
      const replacement = `First downloaded: ${updates.firstDownloaded}`;
      annotation = regex.test(annotation) 
        ? annotation.replace(regex, replacement)
        : annotation + `\nFirst downloaded: ${updates.firstDownloaded}`;
    }

    // Last updated 업데이트/추가
    if (updates.lastUpdated) {
      const regex = /Last updated: [^\n]*/;
      const replacement = `Last updated: ${updates.lastUpdated}`;
      annotation = regex.test(annotation) 
        ? annotation.replace(regex, replacement)
        : annotation + `\nLast updated: ${updates.lastUpdated}`;
    }

    // Playlists 업데이트/추가
    if (updates.playlists && updates.playlists.length > 0) {
      const regex = /Playlists: [^\n]*/;
      const replacement = `Playlists: ${updates.playlists.join(', ')}`;
      annotation = regex.test(annotation) 
        ? annotation.replace(regex, replacement)
        : annotation + `\nPlaylists: ${updates.playlists.join(', ')}`;
    }

    return annotation.trim();
  }

  /**
   * 중복 영상을 처리 (Eagle 아이템에 새 폴더 추가)
   * @param {Object} duplicateInfo - findExistingVideoInLibrary 결과
   * @param {string} newPlaylistFolderId - 새로 추가할 재생목록 폴더 ID
   * @param {string} newPlaylistName - 새 재생목록 이름
   * @param {Object} metadata - 영상 메타데이터
   */
  async processDuplicateVideo(duplicateInfo, newPlaylistFolderId, newPlaylistName, metadata) {
    try {
      const EAGLE_TIMEOUT_MS = 15000;
      const withTimeout = (promise) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Eagle API timeout")), EAGLE_TIMEOUT_MS))
      ]);

      console.log(`[DuplicateHandler] 중복 영상 Eagle 처리 시작: ${duplicateInfo.videoId} → 폴더: ${newPlaylistName}`);
      
      // Eagle에서 기존 아이템 찾기
      const searchURL = `https://www.youtube.com/watch?v=${duplicateInfo.videoId}`;
      console.log(`[DuplicateHandler] Eagle에서 아이템 검색: ${searchURL}`);
      
      const items = await withTimeout(eagle.item.get({ url: searchURL }));
      
      if (!items || items.length === 0) {
        console.warn(`[DuplicateHandler] Eagle에서 아이템을 찾을 수 없음: ${duplicateInfo.videoId}`);
        return false;
      }
      
      const existingItem = items[0];
      console.log(`[DuplicateHandler] 기존 Eagle 아이템 발견: "${existingItem.name}" (ID: ${existingItem.id})`);
      
      // 현재 폴더 목록 확인
      const currentFolders = existingItem.folders || [];
      console.log(`[DuplicateHandler] 현재 폴더 목록:`, currentFolders);
      
      // 새 폴더가 이미 포함되어 있는지 확인
      if (currentFolders.includes(newPlaylistFolderId)) {
        console.log(`[DuplicateHandler] 폴더 이미 포함됨: ${newPlaylistName} (${newPlaylistFolderId})`);
        return true;
      }
      
      // 새 폴더 추가 (중복 제거)
      const updatedFolders = [...new Set([...currentFolders, newPlaylistFolderId])];
      console.log(`[DuplicateHandler] 업데이트된 폴더 목록:`, updatedFolders);
      
      // annotation 업데이트 (재생목록 정보 추가)
      const currentPlaylists = this.extractPlaylistsFromAnnotation(existingItem.annotation || '');
      const updatedPlaylists = [...new Set([...currentPlaylists, newPlaylistName])];
      
      const updatedAnnotation = this.updateAnnotationSection(existingItem.annotation || '', {
        playlists: updatedPlaylists,
        lastUpdated: new Date().toISOString().split('T')[0]
      });
      
      // Eagle 아이템 업데이트
      existingItem.folders = updatedFolders;
      existingItem.annotation = updatedAnnotation;
      
      await withTimeout(existingItem.save());
      
      console.log(`✅ [DuplicateHandler] Eagle 아이템 업데이트 완료: "${existingItem.name}" → 새 폴더 "${newPlaylistName}" 추가`);
      return true;
      
    } catch (error) {
      if (error.message === "Eagle API timeout") {
        console.error(`[DuplicateHandler] Eagle API 타임아웃: ${duplicateInfo.videoId}`);
      } else {
        console.error(`[DuplicateHandler] Eagle 처리 실패 for ${duplicateInfo.videoId}:`, error);
      }
      return false;
    }
  }

  /**
   * annotation에서 기존 플레이리스트 목록 추출
   * @param {string} annotation - 기존 annotation
   * @returns {Array<string>} 플레이리스트 이름 배열
   */
  extractPlaylistsFromAnnotation(annotation) {
    const match = annotation.match(/Playlists: ([^\n]*)/);
    if (match && match[1]) {
      return match[1].split(', ').map(p => p.trim()).filter(p => p);
    }
    return [];
  }

  /**
   * 중복 영상 DB 레코드 생성
   * @param {Object} params - DB 레코드 생성 파라미터
   */
  async createDuplicateRecord(params) {
    const {
      playlistId,
      videoId,
      title,
      masterVideoId,
      metadata,
      folderId
    } = params;

    const duplicateVideoData = {
      playlist_id: playlistId,
      video_id: videoId,
      title: title || metadata.title || videoId,
      status: 'completed',
      downloaded: false, // 실제로는 다운로드 안 함
      auto_download: false,
      skip: false,
      eagle_linked: true, // Eagle에는 이미 있음
      is_duplicate: true,
      master_video_id: masterVideoId,
      duplicate_check_date: new Date().toISOString(),
      source_playlist_url: `playlist_${playlistId}`,
      first_attempt: new Date().toISOString(),
      folder_id: folderId || null
    };

    try {
      const recordId = await subscriptionDb.addVideo(duplicateVideoData);
      console.log(`[DuplicateHandler] 중복 영상 DB 레코드 생성: ${videoId} (ID: ${recordId})`);
      return recordId;
    } catch (error) {
      console.error(`[DuplicateHandler] 중복 영상 DB 레코드 생성 실패:`, error);
      throw error;
    }
  }
}

module.exports = DuplicateHandler;
