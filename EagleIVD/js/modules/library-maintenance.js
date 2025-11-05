/**
 * 라이브러리 유지 관리 모듈
 * 중복 검사 및 Eagle 라이브러리와 SQLite DB 일치성 검사 기능 제공
 */

const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const subscriptionDb = require('./subscription-db'); // SQLite DB 모듈 추가

/**
 * 라이브러리 유지 관리 클래스
 */
class LibraryMaintenance extends EventEmitter {
  /**
   * 라이브러리 유지 관리 초기화
   * @param {string} pluginPath - 플러그인 경로
   */
  constructor(pluginPath) {
    super();
    this.pluginPath = pluginPath;
    this.isRunning = false;
    
    // 작업 상태 및 통계
    this.stats = {
      duplicatesFound: 0,
      duplicatesResolved: 0,
      inconsistenciesFound: 0,
      inconsistenciesResolved: 0,
      errors: []
    };
  }

  /**
   * Eagle 라이브러리 내 중복 영상 검사 및 처리
   * DB의 video_id를 기반으로 Eagle에서 중복 아이템을 찾습니다.
   * @returns {Promise<object>} 검사 결과 리포트
   */
  async checkDuplicates() {
    if (this.isRunning) {
      throw new Error("이미 작업이 실행 중입니다");
    }

    this.resetStats();

    try {
      this.isRunning = true;
      this.emit('statusUpdate', "Eagle 라이브러리 중복 검사를 시작합니다...");

      // DB에서 모든 비디오 ID 가져오기
      const allDbVideoIds = await subscriptionDb.getAllVideoIds();
      const videoIdCounts = allDbVideoIds.reduce((acc, id) => {
        acc[id] = (acc[id] || 0) + 1;
        return acc;
      }, {});

      // DB에 1번 초과 등장하는 videoId (다른 재생목록에 속할 가능성 있는 ID) 추출
      // 실제 중복 여부는 Eagle에서 확인
      const potentialDuplicateIds = Object.entries(videoIdCounts)
        .filter(([_, count]) => count > 1)
        .map(([videoId, _]) => videoId);

      // 또는 모든 videoId를 대상으로 검사할 수도 있음 (옵션)
      // const potentialDuplicateIds = [...new Set(allDbVideoIds)];

      this.emit('statusUpdate', `DB 기반 검사: ${potentialDuplicateIds.length}개의 잠재적 중복 VideoID 발견`);
      console.log(`DB 기반 검사: ${potentialDuplicateIds.length}개의 잠재적 중복 VideoID 발견`);

      // 각 잠재적 중복 ID에 대해 Eagle 라이브러리 확인
      let checkedCount = 0;
      for (const videoId of potentialDuplicateIds) {
        await this.resolveEagleDuplicate(videoId);
        checkedCount++;
        if (checkedCount % 50 === 0) {
            this.emit('statusUpdate', `Eagle 중복 확인 중: ${checkedCount}/${potentialDuplicateIds.length}`);
        }
      }

      // 결과 리포트 작성
      const report = this.generateReport();
      const reportPath = path.join(this.pluginPath, "duplicate-check-report.json");
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

      this.emit('statusUpdate', `Eagle 중복 검사 완료: ${this.stats.duplicatesResolved}개 항목 처리됨`);
      console.log(`Eagle 중복 검사 완료: ${this.stats.duplicatesResolved}개 항목 처리됨, 리포트 저장: ${reportPath}`);

      return report;
    } catch (error) {
      console.error("Eagle 중복 검사 중 오류:", error);
      this.stats.errors.push(error.message);
      this.emit('statusUpdate', `Eagle 중복 검사 오류: ${error.message}`);
      throw error;
    } finally {
      this.isRunning = false;
      this.emit('checkComplete', 'duplicates');
    }
  }

  /**
   * 특정 VideoID에 대해 Eagle 라이브러리 내 중복 항목 처리
   * @param {string} videoId - 비디오 ID
   * @returns {Promise<void>}
   */
  async resolveEagleDuplicate(videoId) {
    try {
      // annotation에서 정확한 Video ID 매칭으로 검색
      const allItems = await eagle.item.get({
        annotation: `Video ID: ${videoId}\n` // 정확한 매칭을 위해 줄바꿈 포함
      });

      if (allItems.length <= 1) {
        // console.log(`VideoID ${videoId}: Eagle 내 중복 항목 없음, 스킵`);
        return;
      }

      console.log(`VideoID ${videoId} 검색 결과:`, allItems.length, '개 항목 발견');
      // allItems.forEach(item => {
      //   console.log('- Item:', item.id, item.name, '\n  Folders:', item.folders);
      // });

      this.stats.duplicatesFound += allItems.length - 1; // 발견된 중복 건수 (원본 제외)
      this.emit('statusUpdate', `Eagle 중복 처리 중: VideoID ${videoId} (${allItems.length}개 발견)`);

      // 가장 오래된 항목(primary)과 그 외 중복 항목 분리
      const sorted = allItems.sort((a, b) => a.added - b.added);
      const primary = sorted[0];
      const duplicates = sorted.slice(1);

      // 메타데이터 통합
      const mergedMetadata = this.mergeMetadata(primary, duplicates);

      // 중복 항목만 휴지통으로 이동
      for (const dup of duplicates) {
        try {
          const item = await eagle.item.getById(dup.id);
          if (item && !item.isDeleted) {
            item.isDeleted = true;
            await item.save();
            console.log(`중복 항목 휴지통으로 이동: ${item.id} (${item.name})`);
          } else if (!item) {
            console.warn(`Item ${dup.id}를 찾을 수 없습니다.`);
          } else {
             // console.log(`Item ${dup.id} is already deleted.`);
          }
        } catch (err) {
          console.error(`Item ${dup.id}을(를) 휴지통으로 이동 중 오류 발생:`, err);
          this.stats.errors.push(`중복 항목 이동 실패 (${dup.id}): ${err.message}`);
        }
      }

      // primary 항목 업데이트 (메타데이터만 수정)
      try {
        const primaryItem = await eagle.item.getById(primary.id);
        if (primaryItem) {
          primaryItem.folders = mergedMetadata.folders;
          primaryItem.tags = mergedMetadata.tags;
          primaryItem.annotation = mergedMetadata.annotation;
          await primaryItem.save();
          console.log(`Primary 항목 업데이트 완료: ${primaryItem.id} (${primaryItem.name})`);
        } else {
          console.warn(`Primary Item ${primary.id}를 찾을 수 없습니다.`);
        }
      } catch (err) {
        console.error(`Primary 항목 업데이트 중 오류 발생:`, err);
        this.stats.errors.push(`Primary 항목 업데이트 실패 (${primary.id}): ${err.message}`);
      }

      this.stats.duplicatesResolved++; // 그룹 단위로 1개 통합 처리
      this.emit('statusUpdate', `Eagle 중복 해결: VideoID ${videoId} (1개 통합)`);
      console.log(`Eagle 중복 해결: VideoID ${videoId} (1개 통합)`);

    } catch (error) {
      console.error(`VideoID ${videoId} 처리 중 오류:`, error);
      this.stats.errors.push(`VideoID ${videoId}: ${error.message}`);
      this.emit('statusUpdate', `오류: VideoID ${videoId} 처리 실패 - ${error.message}`);
    }
  }

  /**
   * 메타데이터 통합
   * @param {object} primary - 주 항목
   * @param {Array} duplicates - 중복 항목 배열
   * @returns {object} 통합된 메타데이터
   */
  mergeMetadata(primary, duplicates) {
    const merged = {
      folders: new Set(primary.folders || []),
      tags: new Set(primary.tags || []),
      annotation: primary.annotation || ''
    };

    for (const dup of duplicates) {
      if (dup.folders) dup.folders.forEach(f => merged.folders.add(f));
      if (dup.tags) dup.tags.forEach(t => merged.tags.add(t));
      // Annotation은 첫 번째 중복 항목 것만 추가 (너무 길어지는 것 방지)
      if (dup.annotation && dup.annotation !== primary.annotation && !merged.annotation.includes("=== 통합된 주석 ===")) {
          merged.annotation += `\n\n=== 통합된 주석 ===\n${dup.annotation}`;
      }
    }

    return {
      folders: Array.from(merged.folders),
      tags: Array.from(merged.tags),
      annotation: merged.annotation.trim()
    };
  }

  /**
   * SQLite DB와 Eagle 라이브러리 일치성 검사
   * @returns {Promise<object>} 검사 결과 리포트
   */
  async checkConsistency() {
    this.resetStats();

    try {
      this.emit('statusUpdate', "라이브러리 일치성 검사를 시작합니다...");

      // DB의 모든 videoId 수집
      const dbVideoIds = new Set(await subscriptionDb.getAllVideoIds());
      this.emit('statusUpdate', `SQLite DB에서 ${dbVideoIds.size}개의 고유 비디오 ID를 발견했습니다`);

      // Eagle의 모든 YouTube 영상 검색 (기존 로직 유지)
      const eagleItems = await eagle.item.get({
        tags: ["Platform: youtube.com"]
      });
      this.emit('statusUpdate', `Eagle 라이브러리에서 ${eagleItems.length}개의 YouTube 항목을 발견했습니다`);

      // Eagle 항목의 videoId 추출 (기존 로직 유지, Default Playlist 제외)
      const eagleVideoIds = new Set();
      // const eagleIdMap = new Map(); // 필요시 사용
      let processedCount = 0;
      let defaultPlaylistId = null;
      try {
          const allFolders = await eagle.folder.getAll();
          const defaultPlaylistFolder = allFolders.find(f => f.name === "Default Playlist");
          if (defaultPlaylistFolder) defaultPlaylistId = defaultPlaylistFolder.id;
      } catch (folderError) {
          console.warn("Eagle 폴더 목록 로드 실패:", folderError);
      }

      for (const item of eagleItems) {
        if (defaultPlaylistId && item.folders && item.folders.includes(defaultPlaylistId)) {
          continue;
        }
        const videoId = this.extractVideoId(item);
        if (videoId) {
          eagleVideoIds.add(videoId);
          // eagleIdMap.set(videoId, item);
        }
        processedCount++;
        if (processedCount % 100 === 0) {
          this.emit('statusUpdate', `Eagle 라이브러리 항목 분석 중: ${processedCount}/${eagleItems.length}`);
        }
      }
      this.emit('statusUpdate', `Eagle 라이브러리에서 ${eagleVideoIds.size}개의 고유 비디오 ID를 추출했습니다 (Default Playlist 폴더 제외)`);

      // 불일치 항목 찾기 (기존 로직 유지)
      const missingInEagle = Array.from(dbVideoIds).filter(id => !eagleVideoIds.has(id));
      const missingInDB = Array.from(eagleVideoIds).filter(id => !dbVideoIds.has(id));

      this.stats.inconsistenciesFound = missingInEagle.length + missingInDB.length;

      // 리포트 생성 (기존 로직 유지)
      const report = {
        timestamp: new Date(),
        summary: {
          totalVideosInDB: dbVideoIds.size,
          totalVideosInEagle: eagleVideoIds.size,
          missingInEagle: missingInEagle.length,
          missingInDB: missingInDB.length
        },
        details: {
          missingInEagle: missingInEagle,
          missingInDB: missingInDB
        }
      };

      // 리포트 저장 (기존 로직 유지)
      const reportPath = path.join(this.pluginPath, "consistency-check-report.json");
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

      this.emit('statusUpdate',
        `일치성 검사 완료: DB에는 있지만 Eagle에 없는 항목 ${missingInEagle.length}개, Eagle에는 있지만 DB에 없는 항목 ${missingInDB.length}개 (Default Playlist 폴더 제외)`
      );
      console.log(`일치성 검사 완료:
        - DB에는 있지만 Eagle에 없는 항목: ${missingInEagle.length}개
        - Eagle에는 있지만 DB에 없는 항목: ${missingInDB.length}개
        - Default Playlist 폴더의 아이템은 검사에서 제외됨
        상세 내용은 ${reportPath} 참조`);

      return report;
    } catch (error) {
      console.error("일치성 검사 중 오류:", error);
      this.stats.errors.push(error.message);
      this.emit('statusUpdate', `일치성 검사 오류: ${error.message}`);
      throw error;
    } finally {
      this.emit('checkComplete', 'consistency');
    }
  }

  /**
   * DB에서 불일치 항목 삭제
   * DB에는 있지만 Eagle 라이브러리에 없는 항목을 DB에서 제거합니다.
   * @returns {Promise<object>} 삭제 결과 리포트
   */
  async removeInconsistenciesFromDB() {
    if (this.isRunning) {
        throw new Error("이미 작업이 실행 중입니다");
    }
    this.isRunning = true;
    this.resetStats();

    try {
      this.emit('statusUpdate', 'DB에서 불일치 항목 삭제 시작...');

      // DB와 Eagle 비디오 ID 목록 가져오기 (checkConsistency 로직 재사용)
      const dbVideoIds = new Set(await subscriptionDb.getAllVideoIds());
      const eagleItems = await eagle.item.get({ tags: ["Platform: youtube.com"] });
      const eagleVideoIds = new Set();
      let defaultPlaylistId = null;
      try {
          const allFolders = await eagle.folder.getAll();
          const defaultPlaylistFolder = allFolders.find(f => f.name === "Default Playlist");
          if (defaultPlaylistFolder) defaultPlaylistId = defaultPlaylistFolder.id;
      } catch (folderError) { console.warn("Eagle 폴더 목록 로드 실패:", folderError); }

      for (const item of eagleItems) {
          if (defaultPlaylistId && item.folders && item.folders.includes(defaultPlaylistId)) continue;
          const videoId = this.extractVideoId(item);
          if (videoId) eagleVideoIds.add(videoId);
      }

      const missingInEagle = Array.from(dbVideoIds).filter(id => !eagleVideoIds.has(id));
      this.stats.inconsistenciesFound = missingInEagle.length;

      if (missingInEagle.length === 0) {
          this.emit('statusUpdate', "DB 삭제: Eagle에 없는 항목이 없어 DB 삭제 작업을 건너<0xEB><0x9C><0x8D>니다.");
          return this.generateFixReport('remove-db');
      }

      // DB에서 해당 항목 삭제
      let removedCount = 0;
      for (const videoId of missingInEagle) {
        try {
          await subscriptionDb.deleteVideoByVideoId(videoId);
          removedCount++;
           if (removedCount % 50 === 0) {
                this.emit('statusUpdate', `DB에서 항목 삭제 중: ${removedCount}/${missingInEagle.length}`);
            }
        } catch (deleteError) {
          console.error(`DB에서 VideoID ${videoId} 삭제 중 오류:`, deleteError);
          this.stats.errors.push(`DB 삭제 실패 (${videoId}): ${deleteError.message}`);
        }
      }

      this.stats.inconsistenciesResolved = removedCount;
      this.emit('statusUpdate', `DB에서 불일치 항목 ${removedCount}개 삭제 완료`);
      console.log(`DB에서 불일치 항목 ${removedCount}개 삭제 완료`);

      return this.generateFixReport('remove-db');

    } catch (error) {
      console.error('DB에서 불일치 항목 삭제 중 오류 발생:', error);
      this.stats.errors.push(error.message);
      this.emit('statusUpdate', '오류: DB에서 불일치 항목 삭제 실패');
       throw error;
    } finally {
      this.isRunning = false;
      this.emit('fixComplete', 'remove-db');
    }
  }

  /**
   * Eagle 항목에서 VideoID 추출
   * @param {object} eagleItem - Eagle 항목
   * @returns {string|null} 비디오 ID
   */
  extractVideoId(eagleItem) {
    // annotation에서 추출 (가장 신뢰할 수 있음)
    if (eagleItem.annotation) {
      const match = eagleItem.annotation.match(/Video ID: ([a-zA-Z0-9_-]+)/);
      if (match) return match[1];
    }

    // URL에서 추출 (Eagle API 문서: Item 객체는 url 속성만 존재)
    const url = eagleItem.url;
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
   * 상태 통계 초기화
   */
  resetStats() {
      this.stats = {
        duplicatesFound: 0,
        duplicatesResolved: 0,
        inconsistenciesFound: 0,
        inconsistenciesResolved: 0,
        errors: []
      };
  }

  /**
   * 상태 리포트 생성
   * @returns {object} 상태 리포트
   */
  generateReport() {
    return {
      timestamp: new Date(),
      ...this.stats,
      isRunning: this.isRunning
    };
  }

  /**
   * 수정 작업 리포트 생성 및 저장
   * @param {string} mode - 실행된 작업 모드
   * @returns {Promise<object>} 생성된 리포트 객체
   */
   async generateFixReport(mode) {
      const fixReport = {
        timestamp: new Date(),
        mode: mode,
        resolved: this.stats.inconsistenciesResolved,
        errors: this.stats.errors
      };
      const fixReportPath = path.join(this.pluginPath, `consistency-${mode}-fix-report.json`);
      try {
          await fs.writeFile(fixReportPath, JSON.stringify(fixReport, null, 2), 'utf8');
          console.log(`${mode} 작업 리포트 저장 완료: ${fixReportPath}`);
      } catch (writeError) {
          console.error(`${mode} 작업 리포트 저장 실패:`, writeError);
      }
      return fixReport;
   }
}

// 모듈 내보내기
module.exports = LibraryMaintenance; 