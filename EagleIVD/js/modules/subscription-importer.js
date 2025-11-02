const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
  const subscriptionDb = require('./subscription-db'); // DB 모듈 추가

/**
 * 다운로드된 파일을 Eagle에 추가하고 정리하는 로직
 */
class SubscriptionImporter extends EventEmitter {
  /**
   * @param {function} updateStatusUI - 상태 메시지 업데이트 콜백
   * @param {boolean} prefixUploadDate - 파일명 앞에 업로드 날짜를 붙일지 여부
   * @param {number} libraryId - 라이브러리 ID
   */
  constructor(updateStatusUI, prefixUploadDate = true, libraryId = null) {
    super();
    this.updateStatusUI = updateStatusUI;
    this.prefixUploadDate = prefixUploadDate;
    this.libraryId = libraryId;
  }

  /**
   * URL에서 재생목록 ID 추출
   * @param {string} url
   * @returns {string|null}
   */
  getPlaylistId(url) {
    const match = url.match(/list=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  /**
   * 파일을 임포트한 후 다운로드 폴더를 정리합니다.
   * @param {string} folder - 다운로드된 파일이 있는 폴더 경로
   * @param {string} url - 원본 플레이리스트/채널 URL
   * @param {object} metadata - 플레이리스트 메타데이터
   * @param {string} customFolderName - 사용자 지정 폴더 이름
   * @param {object} videoMetadata - 각 비디오 ID별 메타데이터 매핑
   */
  async importAndRemoveDownloadedFiles(folder, url, metadata, customFolderName, videoMetadata = {}) {
    try {
      const files = await fs.readdir(folder);
      console.log("Files in directory:", files);

      // 30초 타임아웃 헬퍼
      const IMPORT_TIMEOUT_MS = 30000;
      const withTimeout = (promise) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Import timeout")), IMPORT_TIMEOUT_MS))
      ]);

      // 폴더명 결정: customFolderName 우선, 없으면 fallback
      const folderName = customFolderName && customFolderName.trim() ? 
        customFolderName : (metadata.playlist || this.getPlaylistId(url) || "Default Playlist");

      // 기존 폴더 확인 또는 생성
      let playlistFolderId = null;
      console.log(`Looking for existing folder: "${folderName}"`);
      try {
        const allFolders = await eagle.folder.getAll();
        console.log(`Total folders: ${allFolders.length}`);
        const exactMatch = allFolders.filter(f => f.name === folderName);
        if (exactMatch.length > 0) {
          playlistFolderId = exactMatch[0].id;
          console.log(`Using existing folder: "${folderName}" (ID: ${playlistFolderId})`);
        } else {
          try {
            const newFolder = await eagle.folder.create({ name: folderName });
            playlistFolderId = newFolder.id;
            console.log(`Created new folder: "${folderName}" (ID: ${playlistFolderId})`);
          } catch (createError) {
            if (createError.message.includes("already exists")) {
              const updated = await eagle.folder.getAll();
              const retry = updated.filter(f => f.name === folderName);
              if (retry.length > 0) {
                playlistFolderId = retry[0].id;
                console.log(`Using newly found folder: "${folderName}" (ID: ${playlistFolderId})`);
              }
            } else {
              throw createError;
            }
          }
        }
        if (!playlistFolderId) {
          console.error(`Failed to create or find folder: "${folderName}"`);
        }
      } catch (err) {
        console.error("Error in folder operations:", err);
        throw err;
      }

      // 파일 추가 및 삭제
      for (const file of files) {
        // 임시 파일들과 텍스트 파일 스킵 (더 강화된 필터링)
        if (file.endsWith(".part") || 
            file.endsWith(".ytdl") || 
            file.endsWith(".txt") ||
            file.endsWith(".tmp") ||
            file.endsWith(".downloading") ||
            file.includes(".part") ||
            file.includes(".temp") ||
            file.startsWith(".")) {
          console.log("Skipping temporary/non-video file:", file);
          continue;
        }
        
        const filePath = path.join(folder, file);
        try {
          const stats = await fs.stat(filePath);
          if (!stats.isFile()) continue;
          
          // 파일 크기가 너무 작으면 스킵 (1KB 미만)
          if (stats.size < 1024) {
            console.log(`Skipping too small file: ${file} (${stats.size} bytes)`);
            await fs.unlink(filePath);
            continue;
          }
          // 파일 이름에서 영상 정보 추출 (ID prefix 제거됨)
          let videoId = null;
          let currentMeta = metadata; // 기본값으로 일반 메타데이터 사용
          
          // videoMetadata에서 파일명과 매칭되는 영상 찾기
          for (const [id, meta] of Object.entries(videoMetadata || {})) {
            // 파일명이 영상 제목과 매칭되는지 확인
            const cleanTitle = (meta.title || '').replace(/[^\w\s-]/g, '').trim();
            const cleanFileName = file.replace(/\.[^.]+$/, '').replace(/[^\w\s-]/g, '').trim();
            
            if (cleanFileName.includes(cleanTitle.substring(0, Math.min(20, cleanTitle.length))) || 
                cleanFileName.includes(id)) {
              videoId = id;
              currentMeta = meta;
              console.log(`✅ Found video metadata for "${file}": ${meta.title} (${id})`);
              break;
            }
          }
          
          // videoId를 찾지 못한 경우 URL에서 추출 시도  
          if (!videoId) {
            const urlMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
            videoId = urlMatch ? urlMatch[1] : null;
            
            if (videoId && videoMetadata && videoMetadata[videoId]) {
              currentMeta = videoMetadata[videoId];
              console.log(`✅ Found video metadata from URL for "${file}": ${currentMeta.title} (${videoId})`);
            } else {
              console.warn(`⚠️ Could not find individual video metadata for: ${file}`);
            }
          }
          
          // 파일 제목 처리 (ID prefix 제거 불필요)
          let title = path.basename(file, path.extname(file));
          let displayName = title;
          
          // 업로드 날짜 prefix 추가 (개별 영상의 날짜 사용)
          if (this.prefixUploadDate && currentMeta.upload_date) {
            displayName = `${currentMeta.upload_date} ${title}`;
          }
          
          // 각 영상의 개별 정보로 Eagle 메타데이터 구성 (영어, 간단하게)
          const fileMeta = {
            name: displayName,
            website: videoId ? `https://www.youtube.com/watch?v=${videoId}` : url,
            annotation: `Video title: ${currentMeta.title || title}
Uploader: ${currentMeta.uploader || 'Unknown'}
Upload date: ${currentMeta.upload_date || 'Unknown'}
Views: ${currentMeta.view_count ? currentMeta.view_count.toLocaleString() : 'Unknown'}
Video ID: ${videoId || 'Unknown'}`,
            tags: [
              `Platform: ${url.includes('youtube.com') ? 'youtube.com' : new URL(url).hostname}`,
              `Playlist: ${folderName}`,
              `Channel: ${currentMeta.uploader || 'Unknown'}`,
              ...(currentMeta.upload_date ? [`Year: ${currentMeta.upload_date.substring(0, 4)}`] : [])
            ].filter(Boolean),
            folders: playlistFolderId ? [playlistFolderId] : []
          };
          
          console.log(`🎯 Eagle metadata prepared for "${file}":`, {
            name: fileMeta.name,
            website: fileMeta.website,
            videoTitle: currentMeta.title,
            uploader: currentMeta.uploader
          });
          try {
            const item = await withTimeout(eagle.item.addFromPath(filePath, fileMeta));
            console.log(`Added ${file} to Eagle`, item);
            this.emit('videoAdded', { file, metadata: fileMeta });
            // Eagle 추가 성공 시 DB 업데이트 (라이브러리별 분리)
            try {
              if (videoId) {
                console.log(`[DB Debug] Attempting to mark video ${videoId} as eagle_linked for library ${this.libraryId}`);
                await subscriptionDb.markVideoAsEagleLinked(videoId, this.libraryId);
                console.log(`[DB Update] Successfully marked video ${videoId} as eagle_linked for library ${this.libraryId}`);
              } else {
                console.warn(`[DB Update] videoId is null/undefined for file: ${file}`);
              }
            } catch (dbError) {
              console.error(`[DB Update] Failed to mark video ${videoId} as eagle_linked for library ${this.libraryId}:`, dbError);
            }
          } catch (addErr) {
            if (addErr.message === 'Import timeout') {
              console.error(`Import timeout for ${file}, skipping file.`);
            } else if (addErr.message.includes('Item already exists')) {
              console.log(`${file} already exists, updating folder and metadata`);
              const searchURL = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
              try {
                const items = await withTimeout(eagle.item.get({ url: searchURL }));
                if (items.length) {
                  const existing = items[0];
                  
                  // 폴더 추가 (중복 제거)
                  const currentFolders = existing.folders || [];
                  const newFolders = [...new Set([...currentFolders, playlistFolderId])];
                  
                  // Eagle API 문서에 따른 올바른 방법으로 업데이트
                  existing.folders = newFolders;
                  existing.annotation = fileMeta.annotation; // 최신 메타데이터로 업데이트
                  existing.tags = [...new Set([...(existing.tags || []), ...fileMeta.tags])]; // 태그 병합
                  
                  await withTimeout(existing.save());
                  console.log(`✅ Updated existing item with new folder and metadata: ${existing.name}`);
                  
                  // 중복 항목 처리 시에도 DB 업데이트 (라이브러리별 분리)
                  try {
                    await subscriptionDb.markVideoAsEagleLinked(videoId, this.libraryId);
                    console.log(`[DB Update] Marked existing video ${videoId} as eagle_linked for library ${this.libraryId}.`);
                  } catch (dbError) {
                    console.error(`[DB Update] Failed to mark existing video ${videoId} as eagle_linked for library ${this.libraryId}:`, dbError);
                  }
                } else {
                  console.warn(`No existing item found for URL: ${searchURL}`);
                }
              } catch (dupErr) {
                console.error(`Error updating duplicate for ${file}:`, dupErr);
              }
            } else {
              console.error(`Error adding file ${file}:`, addErr);
            }
          }
          await fs.unlink(filePath);
          console.log(`Removed ${file} from downloads`);
        } catch (fileErr) {
          console.error(`Error processing file ${file}:`, fileErr);
        }
      }
    } catch (err) {
      console.error('Error in importAndRemoveDownloadedFiles:', err);
    }
  }
}

module.exports = SubscriptionImporter;
