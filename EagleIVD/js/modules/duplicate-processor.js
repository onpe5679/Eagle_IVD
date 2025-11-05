/**
 * 중복 비디오 처리 모듈
 * Eagle 동기화 중 중복 비디오를 감지하고 처리
 */

const EventEmitter = require('events');
const subscriptionDb = require('./subscription-db');

class DuplicateProcessor extends EventEmitter {
  constructor() {
    super();
    this.stats = {
      totalChecked: 0,
      duplicatesFound: 0,
      duplicatesProcessed: 0,
      errors: []
    };
  }

  /**
   * 비디오 ID가 DB에 이미 존재하는지 확인
   * @param {string} videoId - YouTube video ID
   * @returns {Promise<{isDuplicate: boolean, existingVideos: Array}>}
   */
  async checkDuplicate(videoId) {
    try {
      const existingVideos = await subscriptionDb.getVideosByVideoId(videoId);
      
      return {
        isDuplicate: existingVideos.length > 0,
        existingVideos: existingVideos
      };
    } catch (error) {
      console.error(`[DuplicateProcessor] Error checking duplicate for ${videoId}:`, error);
      this.stats.errors.push(`Check failed for ${videoId}: ${error.message}`);
      return { isDuplicate: false, existingVideos: [] };
    }
  }

  /**
   * 중복 비디오를 temp_videos에 기록
   * @param {Object} tempVideoData - 임시 비디오 데이터
   * @param {Array} existingVideos - 기존 비디오 레코드
   * @returns {Promise<number>} temp_video ID
   */
  async recordDuplicate(tempVideoData, existingVideos) {
    try {
      const masterVideo = existingVideos[0]; // 첫 번째를 원본으로 간주
      
      const duplicateData = {
        ...tempVideoData,
        is_duplicate: 1,
        master_video_id: masterVideo.video_id
      };
      
      const tempVideoId = await subscriptionDb.addTempVideo(duplicateData);
      this.stats.duplicatesProcessed++;
      
      console.log(`📌 [DuplicateProcessor] Recorded duplicate: ${tempVideoData.video_id} (master: ${masterVideo.video_id})`);
      this.emit('duplicateRecorded', {
        videoId: tempVideoData.video_id,
        masterVideoId: masterVideo.video_id,
        tempVideoId: tempVideoId
      });
      
      return tempVideoId;
    } catch (error) {
      console.error(`[DuplicateProcessor] Error recording duplicate:`, error);
      this.stats.errors.push(`Record failed for ${tempVideoData.video_id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * 배치로 중복 체크
   * @param {Array<string>} videoIds - 비디오 ID 배열
   * @returns {Promise<Map<string, {isDuplicate: boolean, existingVideos: Array}>>}
   */
  async batchCheckDuplicates(videoIds) {
    const results = new Map();
    
    for (const videoId of videoIds) {
      this.stats.totalChecked++;
      const result = await this.checkDuplicate(videoId);
      
      if (result.isDuplicate) {
        this.stats.duplicatesFound++;
      }
      
      results.set(videoId, result);
      
      if (this.stats.totalChecked % 100 === 0) {
        this.emit('progress', {
          checked: this.stats.totalChecked,
          total: videoIds.length,
          duplicatesFound: this.stats.duplicatesFound
        });
        console.log(`[DuplicateProcessor] Progress: ${this.stats.totalChecked}/${videoIds.length} (${this.stats.duplicatesFound} duplicates)`);
      }
    }
    
    return results;
  }

  /**
   * 통계 초기화
   */
  resetStats() {
    this.stats = {
      totalChecked: 0,
      duplicatesFound: 0,
      duplicatesProcessed: 0,
      errors: []
    };
  }

  /**
   * 통계 반환
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * 중복 비디오 리포트 생성
   * @returns {Promise<Object>}
   */
  async generateDuplicateReport() {
    try {
      const duplicates = await subscriptionDb.withTransaction(async (db) => {
        return await db.all(`
          SELECT 
            tv.*,
            tp.eagle_folder_name,
            mv.title as master_title,
            mv.playlist_id as master_playlist_id
          FROM temp_videos tv
          LEFT JOIN temp_playlists tp ON tv.temp_playlist_id = tp.id
          LEFT JOIN videos mv ON tv.master_video_id = mv.video_id
          WHERE tv.is_duplicate = 1
          ORDER BY tv.video_id
        `);
      });

      const report = {
        timestamp: new Date().toISOString(),
        totalDuplicates: duplicates.length,
        stats: this.getStats(),
        duplicates: duplicates
      };

      console.log(`[DuplicateProcessor] Generated report: ${duplicates.length} duplicates`);
      return report;
    } catch (error) {
      console.error('[DuplicateProcessor] Error generating report:', error);
      throw error;
    }
  }
}

module.exports = DuplicateProcessor;
