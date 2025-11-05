/**
 * Eagle → DB 동기화 모듈
 * Eagle 라이브러리의 비디오를 DB로 가져와 임시 테이블에 저장
 */

const EventEmitter = require('events');
const subscriptionDb = require('./subscription-db');
const DuplicateProcessor = require('./duplicate-processor');

class EagleSync extends EventEmitter {
  constructor() {
    super();
    this.duplicateProcessor = new DuplicateProcessor();
    this.isRunning = false;
    
    this.stats = {
      totalFolders: 0,
      totalVideos: 0,
      processedVideos: 0,
      duplicatesFound: 0,
      errors: [],
      startTime: null,
      endTime: null
    };

    // DuplicateProcessor 이벤트 전달
    this.duplicateProcessor.on('progress', (data) => {
      this.emit('duplicateProgress', data);
    });
    
    this.duplicateProcessor.on('duplicateRecorded', (data) => {
      this.emit('duplicateRecorded', data);
    });
  }

  /**
   * Eagle에서 모든 YouTube 비디오를 가져와 DB로 동기화
   * @param {Object} options - 동기화 옵션
   * @param {boolean} options.clearExisting - 기존 temp 데이터 삭제 여부
   * @param {boolean} options.excludeDefaultPlaylist - "Default Playlist" 폴더 제외 여부
   * @returns {Promise<Object>} 동기화 결과
   */
  async syncEagleToDb(options = {}) {
    if (this.isRunning) {
      throw new Error('Sync already in progress');
    }

    const {
      clearExisting = true,
      excludeDefaultPlaylist = true
    } = options;

    try {
      this.isRunning = true;
      this.resetStats();
      this.stats.startTime = new Date();

      this.emit('syncStarted', { options });
      this.emit('statusUpdate', 'Eagle 동기화 시작...');

      // 1. 기존 temp 데이터 삭제 (옵션)
      if (clearExisting) {
        await subscriptionDb.clearTempTables();
        this.emit('statusUpdate', '기존 임시 데이터 삭제 완료');
      }

      // 2. Eagle 폴더 목록 가져오기
      const allFolders = await this.getEagleFolders();
      let folders = allFolders;

      // Default Playlist 제외
      let defaultPlaylistId = null;
      if (excludeDefaultPlaylist) {
        const defaultFolder = allFolders.find(f => f.name === 'Default Playlist');
        if (defaultFolder) {
          defaultPlaylistId = defaultFolder.id;
          folders = allFolders.filter(f => f.id !== defaultPlaylistId);
          console.log(`📁 [EagleSync] Excluding "Default Playlist" folder (ID: ${defaultPlaylistId})`);
        }
      }

      this.stats.totalFolders = folders.length;
      this.emit('statusUpdate', `${folders.length}개 폴더 발견 (Default Playlist 제외)`);

      // 3. 각 폴더별로 비디오 가져오기
      for (let i = 0; i < folders.length; i++) {
        const folder = folders[i];
        await this.processFolderVideos(folder, i + 1, folders.length);
      }

      // 4. 중복 리포트 생성
      const duplicateReport = await this.duplicateProcessor.generateDuplicateReport();
      
      this.stats.endTime = new Date();
      this.stats.duplicatesFound = this.duplicateProcessor.stats.duplicatesFound;

      const finalReport = {
        ...this.stats,
        duration: this.stats.endTime - this.stats.startTime,
        duplicateReport: duplicateReport
      };

      this.emit('syncCompleted', finalReport);
      this.emit('statusUpdate', `동기화 완료: ${this.stats.processedVideos}개 비디오 (${this.stats.duplicatesFound}개 중복)`);

      console.log(`✅ [EagleSync] Sync completed:`, finalReport);
      return finalReport;

    } catch (error) {
      console.error('[EagleSync] Sync error:', error);
      this.stats.errors.push(error.message);
      this.emit('syncError', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Eagle 폴더 목록 가져오기
   * @returns {Promise<Array>}
   */
  async getEagleFolders() {
    try {
      const topLevelFolders = await eagle.folder.getAll();
      
      // 재귀적으로 모든 하위 폴더 수집
      const flattenFolders = (folders) => {
        const result = [];
        for (const folder of folders) {
          result.push(folder);
          if (folder.children && Array.isArray(folder.children) && folder.children.length > 0) {
            result.push(...flattenFolders(folder.children));
          }
        }
        return result;
      };

      const allFolders = flattenFolders(topLevelFolders);
      console.log(`📁 [EagleSync] Found ${allFolders.length} total folders (including subfolders)`);
      
      return allFolders;
    } catch (error) {
      console.error('[EagleSync] Error getting folders:', error);
      throw new Error(`Failed to get Eagle folders: ${error.message}`);
    }
  }

  /**
   * 폴더의 비디오 처리
   * @param {Object} folder - Eagle 폴더 객체
   * @param {number} current - 현재 폴더 인덱스
   * @param {number} total - 전체 폴더 수
   */
  async processFolderVideos(folder, current, total) {
    try {
      this.emit('statusUpdate', `[${current}/${total}] 폴더 처리 중: ${folder.name}`);
      console.log(`\n📁 [EagleSync] Processing folder [${current}/${total}]: ${folder.name} (ID: ${folder.id})`);

      // 폴더의 YouTube 비디오 가져오기
      const items = await eagle.item.get({
        folders: [folder.id],
        tags: ['Platform: youtube.com']
      });

      if (items.length === 0) {
        console.log(`  ⏭️  No YouTube videos in folder: ${folder.name}`);
        return;
      }

      console.log(`  📊 Found ${items.length} YouTube videos in folder: ${folder.name}`);

      // 플레이리스트 이름 자동 감지
      const detectedInfo = this.detectPlaylistInfo(items);
      
      // temp_playlists에 폴더 추가
      const tempPlaylistId = await subscriptionDb.addTempPlaylist({
        eagle_folder_id: folder.id,
        eagle_folder_name: folder.name,
        detected_playlist_name: detectedInfo.playlistName,
        video_count: items.length,
        confidence_score: detectedInfo.confidence
      });

      console.log(`  ✅ Created temp_playlist (ID: ${tempPlaylistId}) with confidence: ${(detectedInfo.confidence * 100).toFixed(1)}%`);

      // 각 비디오 처리
      let processedCount = 0;
      for (const item of items) {
        await this.processVideo(item, tempPlaylistId, folder);
        processedCount++;
        this.stats.processedVideos++;

        if (processedCount % 50 === 0) {
          this.emit('statusUpdate', `  처리 중: ${processedCount}/${items.length}`);
        }
      }

      console.log(`  ✅ Processed ${processedCount} videos from folder: ${folder.name}`);

    } catch (error) {
      console.error(`[EagleSync] Error processing folder ${folder.name}:`, error);
      this.stats.errors.push(`Folder ${folder.name}: ${error.message}`);
      this.emit('statusUpdate', `⚠️ 폴더 처리 오류: ${folder.name}`);
    }
  }

  /**
   * 개별 비디오 처리
   * @param {Object} item - Eagle item 객체
   * @param {number} tempPlaylistId - temp_playlist ID
   * @param {Object} folder - Eagle 폴더 객체
   */
  async processVideo(item, tempPlaylistId, folder) {
    try {
      // 비디오 ID 추출
      const videoId = this.extractVideoId(item);
      if (!videoId) {
        console.warn(`  ⚠️  Could not extract video ID from item: ${item.name}`);
        return;
      }

      // 메타데이터 추출
      const metadata = this.extractMetadata(item);

      // 중복 체크 (DB에 이미 있는지 확인)
      const duplicateCheck = await this.duplicateProcessor.checkDuplicate(videoId);

      if (duplicateCheck.isDuplicate) {
        // DB에 이미 있는 비디오는 임시 테이블에 추가하지 않음
        console.log(`  ⏭️  Skipping video already in DB: ${videoId} (${metadata.title || item.name})`);
        this.stats.duplicatesFound++;
        return;
      }

      // DB에 없는 비디오만 임시 테이블에 추가
      const videoData = {
        temp_playlist_id: tempPlaylistId,
        eagle_item_id: item.id,
        video_id: videoId,
        video_url: item.url || `https://www.youtube.com/watch?v=${videoId}`,
        title: metadata.title || item.name,
        uploader: metadata.uploader,
        upload_date: metadata.upload_date,
        view_count: metadata.view_count,
        duration: metadata.duration,
        eagle_folder_id: folder.id
      };

      await subscriptionDb.addTempVideo(videoData);

    } catch (error) {
      console.error(`  ❌ Error processing video ${item.name}:`, error);
      this.stats.errors.push(`Video ${item.name}: ${error.message}`);
    }
  }

  /**
   * Eagle item에서 비디오 ID 추출
   * @param {Object} item - Eagle item
   * @returns {string|null}
   */
  extractVideoId(item) {
    // annotation에서 추출 (가장 신뢰할 수 있음)
    if (item.annotation) {
      const match = item.annotation.match(/Video ID: ([a-zA-Z0-9_-]+)/);
      if (match) return match[1];
    }

    // URL에서 추출 (Eagle API 문서: Item 객체는 url 속성만 존재)
    const url = item.url;
    if (!url) return null;
    
    // YouTube URL에서 video ID 추출 (보통 11자리, 하지만 유연하게 처리)
    // 지원 형식:
    // - https://www.youtube.com/watch?v=VIDEO_ID
    // - https://www.youtube.com/watch?v=VIDEO_ID&other=params
    // - https://youtu.be/VIDEO_ID
    // - https://youtu.be/VIDEO_ID?si=...
    // - youtu.be/VIDEO_ID (프로토콜 없음)
    // - https://www.youtube.com/embed/VIDEO_ID
    // - https://www.youtube.com/v/VIDEO_ID
    
    // 1. youtu.be 단축 URL 형식 (가장 많이 사용)
    let match = url.match(/(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]+?)(?:[?&]|$)/);
    if (match) return match[1];
    
    // 2. youtube.com/watch?v= 형식
    match = url.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]+?)(?:[&]|$)/);
    if (match) return match[1];
    
    // 3. youtube.com/embed/ 형식
    match = url.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]+?)(?:[?&]|$)/);
    if (match) return match[1];
    
    // 4. youtube.com/v/ 형식
    match = url.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]+?)(?:[?&]|$)/);
    if (match) return match[1];
    
    // 5. 마지막 시도: URL 어디든 v= 파라미터 찾기
    match = url.match(/[?&]v=([a-zA-Z0-9_-]+?)(?:[&]|$)/);
    if (match) return match[1];

    return null;
  }

  /**
   * Eagle item에서 메타데이터 추출
   * @param {Object} item - Eagle item
   * @returns {Object}
   */
  extractMetadata(item) {
    const metadata = {
      title: item.name,
      uploader: null,
      upload_date: null,
      view_count: null,
      duration: null
    };

    if (item.annotation) {
      // Uploader 추출
      const uploaderMatch = item.annotation.match(/Uploader: (.+)/);
      if (uploaderMatch) metadata.uploader = uploaderMatch[1].trim();

      // Upload date 추출
      const dateMatch = item.annotation.match(/Upload date: (\d{8})/);
      if (dateMatch) metadata.upload_date = dateMatch[1];

      // Views 추출
      const viewsMatch = item.annotation.match(/Views: ([\d,]+)/);
      if (viewsMatch) {
        metadata.view_count = parseInt(viewsMatch[1].replace(/,/g, ''));
      }
    }

    // tags에서 Channel 추출 (uploader 없을 경우)
    if (!metadata.uploader && item.tags) {
      const channelTag = item.tags.find(tag => tag.startsWith('Channel: '));
      if (channelTag) {
        metadata.uploader = channelTag.replace('Channel: ', '');
      }
    }

    return metadata;
  }

  /**
   * 비디오들로부터 플레이리스트 정보 자동 감지
   * @param {Array} items - Eagle items 배열
   * @returns {Object} {playlistName: string, confidence: number}
   */
  detectPlaylistInfo(items) {
    if (items.length === 0) {
      return { playlistName: null, confidence: 0.0 };
    }

    // tags에서 "Playlist: ..." 추출
    const playlistNames = new Map(); // name -> count

    for (const item of items) {
      if (item.tags) {
        const playlistTag = item.tags.find(tag => tag.startsWith('Playlist: '));
        if (playlistTag) {
          const name = playlistTag.replace('Playlist: ', '').trim();
          playlistNames.set(name, (playlistNames.get(name) || 0) + 1);
        }
      }
    }

    if (playlistNames.size === 0) {
      return { playlistName: null, confidence: 0.0 };
    }

    // 가장 많이 등장한 플레이리스트 이름
    let maxCount = 0;
    let detectedName = null;

    for (const [name, count] of playlistNames.entries()) {
      if (count > maxCount) {
        maxCount = count;
        detectedName = name;
      }
    }

    // 신뢰도 계산: 해당 이름을 가진 비디오 비율
    const confidence = maxCount / items.length;

    console.log(`  🔍 Detected playlist name: "${detectedName}" (${maxCount}/${items.length} videos, confidence: ${(confidence * 100).toFixed(1)}%)`);

    return {
      playlistName: detectedName,
      confidence: confidence
    };
  }

  /**
   * 통계 초기화
   */
  resetStats() {
    this.stats = {
      totalFolders: 0,
      totalVideos: 0,
      processedVideos: 0,
      duplicatesFound: 0,
      errors: [],
      startTime: null,
      endTime: null
    };
    this.duplicateProcessor.resetStats();
  }

  /**
   * 통계 반환
   */
  getStats() {
    return {
      ...this.stats,
      duplicateStats: this.duplicateProcessor.getStats()
    };
  }

  /**
   * temp 데이터를 main 테이블로 마이그레이션
   * @param {number} tempPlaylistId - temp_playlist ID
   * @param {string} playlistUrl - 플레이리스트 URL
   * @returns {Promise<Object>}
   */
  async migrateToMain(tempPlaylistId, playlistUrl) {
    try {
      this.emit('statusUpdate', '메인 DB로 마이그레이션 시작...');

      // temp_playlist 조회
      const tempPlaylist = await subscriptionDb.withTransaction(async (db) => {
        return await db.get('SELECT * FROM temp_playlists WHERE id = ?', [tempPlaylistId]);
      });

      if (!tempPlaylist) {
        throw new Error(`Temp playlist ${tempPlaylistId} not found`);
      }

      // playlists 테이블에 추가 또는 기존 플레이리스트 사용
      let mainPlaylistId;
      const existingPlaylist = await subscriptionDb.getPlaylistByUrl(playlistUrl);

      if (existingPlaylist) {
        mainPlaylistId = existingPlaylist.id;
        console.log(`Using existing playlist: ${existingPlaylist.user_title} (ID: ${mainPlaylistId})`);
      } else {
        // 새 플레이리스트 생성
        mainPlaylistId = await subscriptionDb.addPlaylist({
          user_title: tempPlaylist.detected_playlist_name || tempPlaylist.eagle_folder_name,
          youtube_title: tempPlaylist.detected_playlist_name || tempPlaylist.eagle_folder_name,
          url: playlistUrl,
          eagle_folder_id: tempPlaylist.eagle_folder_id,
          videos_from_yt: 0,
          videos: 0,
          format: 'best',
          quality: ''
        });
        console.log(`Created new playlist (ID: ${mainPlaylistId})`);
      }

      // temp_videos를 videos 테이블로 마이그레이션 (중복 제외)
      const tempVideos = await subscriptionDb.getTempVideosByPlaylist(tempPlaylistId);
      const nonDuplicateVideos = tempVideos.filter(v => v.is_duplicate === 0);

      let migratedCount = 0;
      for (const tempVideo of nonDuplicateVideos) {
        await subscriptionDb.migrateTempVideoToMain(tempVideo.id, mainPlaylistId);
        migratedCount++;
      }

      // temp_playlist 업데이트
      await subscriptionDb.updateTempPlaylist(tempPlaylistId, {
        playlist_url: playlistUrl,
        synced_to_main: 1,
        synced_playlist_id: mainPlaylistId
      });

      // playlists.videos 업데이트
      await subscriptionDb.updatePlaylist(mainPlaylistId, {
        videos: (existingPlaylist?.videos || 0) + migratedCount
      });

      const result = {
        tempPlaylistId,
        mainPlaylistId,
        migratedVideos: migratedCount,
        skippedDuplicates: tempVideos.length - nonDuplicateVideos.length
      };

      this.emit('migrationCompleted', result);
      console.log(`✅ [EagleSync] Migration completed:`, result);

      return result;

    } catch (error) {
      console.error('[EagleSync] Migration error:', error);
      throw error;
    }
  }

  /**
   * temp 데이터를 기존 플레이리스트에 추가
   * @param {number} tempPlaylistId - temp_playlist ID
   * @param {number} existingPlaylistId - 기존 플레이리스트 ID
   * @returns {Promise<Object>}
   */
  async migrateToExistingPlaylist(tempPlaylistId, existingPlaylistId) {
    try {
      this.emit('statusUpdate', '기존 플레이리스트에 추가 중...');

      // temp_playlist 조회
      const tempPlaylist = await subscriptionDb.withTransaction(async (db) => {
        return await db.get('SELECT * FROM temp_playlists WHERE id = ?', [tempPlaylistId]);
      });

      if (!tempPlaylist) {
        throw new Error(`Temp playlist ${tempPlaylistId} not found`);
      }

      // 기존 플레이리스트 조회
      const existingPlaylist = await subscriptionDb.getPlaylistById(existingPlaylistId);
      if (!existingPlaylist) {
        throw new Error(`Playlist ${existingPlaylistId} not found`);
      }

      console.log(`Adding to existing playlist: ${existingPlaylist.user_title} (ID: ${existingPlaylistId})`);

      // temp_videos를 videos 테이블로 마이그레이션 (중복 제외)
      const tempVideos = await subscriptionDb.getTempVideosByPlaylist(tempPlaylistId);
      const nonDuplicateVideos = tempVideos.filter(v => v.is_duplicate === 0);

      let migratedCount = 0;
      for (const tempVideo of nonDuplicateVideos) {
        await subscriptionDb.migrateTempVideoToMain(tempVideo.id, existingPlaylistId);
        migratedCount++;
      }

      // temp_playlist 업데이트
      await subscriptionDb.updateTempPlaylist(tempPlaylistId, {
        playlist_url: existingPlaylist.url,
        synced_to_main: 1,
        synced_playlist_id: existingPlaylistId
      });

      // playlists.videos 업데이트
      await subscriptionDb.updatePlaylist(existingPlaylistId, {
        videos: existingPlaylist.videos + migratedCount
      });

      const result = {
        tempPlaylistId,
        mainPlaylistId: existingPlaylistId,
        migratedVideos: migratedCount,
        skippedDuplicates: tempVideos.length - nonDuplicateVideos.length
      };

      this.emit('migrationCompleted', result);
      console.log(`✅ [EagleSync] Added to existing playlist:`, result);

      return result;

    } catch (error) {
      console.error('[EagleSync] Migration to existing playlist error:', error);
      throw error;
    }
  }
}

module.exports = EagleSync;
