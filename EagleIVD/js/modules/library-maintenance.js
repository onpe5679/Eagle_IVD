/**
 * 라이브러리 유지 관리 모듈
 * 중복 검사 및 Eagle 라이브러리와 JSON DB 일치성 검사 기능 제공
 */

const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

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
    this.subscriptionsFile = path.join(pluginPath, "subscriptions.json");
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
   * 구독 JSON DB 로드
   * @returns {Promise<Array>} 구독 목록
   */
  async loadSubscriptionsDB() {
    try {
      const content = await fs.readFile(this.subscriptionsFile, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`구독 DB 로드 실패: ${error.message}`);
    }
  }

  /**
   * 구독 JSON DB 저장
   * @param {Array} subscriptions - 구독 목록
   * @returns {Promise<void>}
   */
  async saveSubscriptionsDB(subscriptions) {
    try {
      await fs.writeFile(this.subscriptionsFile, JSON.stringify(subscriptions, null, 2), 'utf8');
    } catch (error) {
      throw new Error(`구독 DB 저장 실패: ${error.message}`);
    }
  }

  /**
   * 중복 검사 및 처리
   * JSON DB 기반으로 중복 검사
   * @returns {Promise<object>} 검사 결과 리포트
   */
  async checkDuplicates() {
    if (this.isRunning) {
      throw new Error("이미 작업이 실행 중입니다");
    }

    // 상태 초기화
    this.stats = {
      duplicatesFound: 0,
      duplicatesResolved: 0,
      inconsistenciesFound: 0,
      inconsistenciesResolved: 0,
      errors: []
    };

    try {
      this.isRunning = true;
      this.emit('statusUpdate', "중복 검사를 시작합니다...");
      
      const subscriptions = await this.loadSubscriptionsDB();
      
      // 모든 구독의 videoIds 수집
      const videoMap = new Map(); // videoId -> 출현 횟수
      
      for (const sub of subscriptions) {
        for (const videoId of sub.videoIds || []) {
          videoMap.set(videoId, (videoMap.get(videoId) || 0) + 1);
        }
      }

      // 중복된 videoId만 필터링
      const duplicateIds = Array.from(videoMap.entries())
        .filter(([_, count]) => count > 1)
        .map(([id]) => id);

      this.emit('statusUpdate', `중복 검사: ${duplicateIds.length}개의 중복 의심 항목 발견`);
      console.log(`중복 검사: ${duplicateIds.length}개의 중복 의심 항목 발견`);

      // 각 중복 항목 처리
      for (const videoId of duplicateIds) {
        await this.resolveDuplicate(videoId);
      }

      // 결과 리포트 작성
      const report = this.generateReport();
      
      const reportPath = path.join(this.pluginPath, "duplicate-check-report.json");
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
      
      this.emit('statusUpdate', `중복 검사 완료: ${this.stats.duplicatesResolved}개 항목 처리됨`);
      console.log(`중복 검사 완료: ${this.stats.duplicatesResolved}개 항목 처리됨, 리포트 저장: ${reportPath}`);
      
      return report;
    } catch (error) {
      console.error("중복 검사 중 오류:", error);
      this.stats.errors.push(error.message);
      this.emit('statusUpdate', `중복 검사 오류: ${error.message}`);
      throw error;
    } finally {
      this.isRunning = false;
      this.emit('checkComplete', 'duplicates');
    }
  }

  /**
   * 개별 중복 항목 처리
   * @param {string} videoId - 비디오 ID
   * @returns {Promise<void>}
   */
  async resolveDuplicate(videoId) {
    try {
      // Eagle에서 해당 videoId를 가진 항목 검색
      const items = await eagle.item.get({
        annotation: `Video ID: ${videoId}`
      });

      // URL 기반으로도 검색 (annotation에 videoId가 없는 경우)
      const urlItems = await eagle.item.get({
        website: `https://www.youtube.com/watch?v=${videoId}`
      });
      
      // 두 결과 병합 (ID 기준 중복 제거)
      const allItems = [...items];
      for (const item of urlItems) {
        if (!allItems.some(i => i.id === item.id)) {
          allItems.push(item);
        }
      }

      if (allItems.length <= 1) {
        console.warn(`경고: VideoID ${videoId}가 Eagle에서 중복으로 발견되지 않음`);
        return;
      }

      this.stats.duplicatesFound++;
      this.emit('statusUpdate', `중복 처리 중: VideoID ${videoId} (${allItems.length}개 발견)`);

      // 가장 오래된 항목을 primary로 선택
      const sortedItems = allItems.sort((a, b) => a.added - b.added);
      const primary = sortedItems[0];
      const duplicates = sortedItems.slice(1);

      // 메타데이터 통합
      const mergedMetadata = this.mergeMetadata(primary, duplicates);

      // 중복 항목 삭제 -> moveToTrash 사용
      for (const dup of duplicates) {
        try {
          // Eagle 항목 객체의 moveToTrash 메서드 호출
          if (typeof dup.moveToTrash === 'function') {
            await dup.moveToTrash();
          } else {
            // 능동적 삭제를 지원하지 않는 경우 경고
            console.warn(`Item ${dup.id}에서 moveToTrash 메서드를 찾을 수 없습니다.`);
          }
        } catch (err) {
          console.error(`Item ${dup.id}을(를) 휴지통으로 이동 중 오류 발생:`, err);
        }
      }

      // primary 항목 업데이트
      await eagle.item.modify(primary.id, mergedMetadata);
      
      this.stats.duplicatesResolved++;
      this.emit('statusUpdate', `중복 해결: VideoID ${videoId} (${duplicates.length}개 통합)`);
      console.log(`중복 해결: VideoID ${videoId} (${duplicates.length}개 통합)`);

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

    // 모든 중복 항목의 메타데이터 통합
    for (const dup of duplicates) {
      if (dup.folders) dup.folders.forEach(f => merged.folders.add(f));
      if (dup.tags) dup.tags.forEach(t => merged.tags.add(t));
      if (dup.annotation && dup.annotation !== primary.annotation) {
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
   * JSON DB와 Eagle 라이브러리 일치성 검사
   * @returns {Promise<object>} 검사 결과 리포트
   */
  async checkConsistency() {
    if (this.isRunning) {
      throw new Error("이미 작업이 실행 중입니다");
    }

    // 상태 초기화
    this.stats = {
      duplicatesFound: 0,
      duplicatesResolved: 0,
      inconsistenciesFound: 0,
      inconsistenciesResolved: 0,
      errors: []
    };

    try {
      this.isRunning = true;
      this.emit('statusUpdate', "라이브러리 일치성 검사를 시작합니다...");
      
      const subscriptions = await this.loadSubscriptionsDB();
      
      // JSON DB의 모든 videoId 수집
      const dbVideoIds = new Set();
      for (const sub of subscriptions) {
        if (sub.videoIds) {
          sub.videoIds.forEach(id => dbVideoIds.add(id));
        }
      }
      
      this.emit('statusUpdate', `JSON DB에서 ${dbVideoIds.size}개의 비디오 ID를 발견했습니다`);

      // Eagle의 모든 YouTube 영상 검색
      const eagleItems = await eagle.item.get({
        tags: ["Platform: youtube.com"]
      });
      
      this.emit('statusUpdate', `Eagle 라이브러리에서 ${eagleItems.length}개의 YouTube 항목을 발견했습니다`);

      // Eagle 항목의 videoId 추출
      const eagleVideoIds = new Set();
      const eagleIdMap = new Map(); // videoId -> eagleItem
      
      // 진행 상황 업데이트 빈도 제한
      let processedCount = 0;
      
      for (const item of eagleItems) {
        const videoId = this.extractVideoId(item);
        if (videoId) {
          eagleVideoIds.add(videoId);
          eagleIdMap.set(videoId, item);
        }
        
        processedCount++;
        if (processedCount % 100 === 0) {
          this.emit('statusUpdate', `Eagle 라이브러리 항목 분석 중: ${processedCount}/${eagleItems.length}`);
        }
      }
      
      this.emit('statusUpdate', `Eagle 라이브러리에서 ${eagleVideoIds.size}개의 비디오 ID를 추출했습니다`);

      // 불일치 항목 찾기
      const missingInEagle = Array.from(dbVideoIds)
        .filter(id => !eagleVideoIds.has(id));
      
      const missingInDB = Array.from(eagleVideoIds)
        .filter(id => !dbVideoIds.has(id));

      this.stats.inconsistenciesFound = missingInEagle.length + missingInDB.length;

      // 리포트 생성
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

      // 리포트 저장
      const reportPath = path.join(this.pluginPath, "consistency-check-report.json");
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

      this.emit('statusUpdate', 
        `일치성 검사 완료: DB에는 있지만 Eagle에 없는 항목 ${missingInEagle.length}개, Eagle에는 있지만 DB에 없는 항목 ${missingInDB.length}개`
      );
      
      console.log(`일치성 검사 완료:
        - DB에는 있지만 Eagle에 없는 항목: ${missingInEagle.length}개
        - Eagle에는 있지만 DB에 없는 항목: ${missingInDB.length}개
        상세 내용은 ${reportPath} 참조`);

      return report;
    } catch (error) {
      console.error("일치성 검사 중 오류:", error);
      this.stats.errors.push(error.message);
      this.emit('statusUpdate', `일치성 검사 오류: ${error.message}`);
      throw error;
    } finally {
      this.isRunning = false;
      this.emit('checkComplete', 'consistency');
    }
  }

  /**
   * 불일치 항목 수정
   * @param {string} mode - 수정 모드 ('db'|'eagle'|'both')
   * @returns {Promise<object>} 수정 결과 리포트
   */
  async fixInconsistencies(mode = 'both') {
    if (this.isRunning) {
      throw new Error("이미 작업이 실행 중입니다");
    }

    try {
      this.isRunning = true;
      
      // 먼저 일치성 검사 실행
      const report = await this.checkConsistency();
      
      // 모드에 따라 수정 작업 수행
      if (mode === 'db' || mode === 'both') {
        // Eagle에는 있지만 DB에 없는 항목을 DB에 추가
        const subscriptions = await this.loadSubscriptionsDB();
        
        // DB에 "기타" 구독 추가 (Eagle에만 있는 항목을 위한 구독)
        let otherSubscription = subscriptions.find(s => s.url === "other_videos");
        
        if (!otherSubscription) {
          otherSubscription = {
            url: "other_videos",
            folderName: "기타 YouTube 영상",
            format: "best",
            quality: "",
            videoIds: [],
            title: "기타 YouTube 영상",
            lastCheck: Date.now()
          };
          subscriptions.push(otherSubscription);
        }
        
        // Eagle에만 있는 항목을 DB에 추가
        const missingInDB = report.details.missingInDB;
        otherSubscription.videoIds = [...new Set([...otherSubscription.videoIds, ...missingInDB])];
        
        // DB 저장
        await this.saveSubscriptionsDB(subscriptions);
        this.stats.inconsistenciesResolved += missingInDB.length;
        this.emit('statusUpdate', `DB 수정 완료: ${missingInDB.length}개 항목을 DB에 추가했습니다`);
      }
      
      // 결과 리포트 작성
      const fixReport = {
        timestamp: new Date(),
        mode: mode,
        resolved: this.stats.inconsistenciesResolved,
        errors: this.stats.errors
      };
      
      // 리포트 저장
      const fixReportPath = path.join(this.pluginPath, "consistency-fix-report.json");
      await fs.writeFile(fixReportPath, JSON.stringify(fixReport, null, 2), 'utf8');
      
      this.emit('statusUpdate', `불일치 수정 완료: ${this.stats.inconsistenciesResolved}개 항목 처리됨`);
      
      return fixReport;
    } catch (error) {
      console.error("불일치 수정 중 오류:", error);
      this.stats.errors.push(error.message);
      this.emit('statusUpdate', `불일치 수정 오류: ${error.message}`);
      throw error;
    } finally {
      this.isRunning = false;
      this.emit('fixComplete');
    }
  }

  /**
   * Eagle 항목에서 VideoID 추출
   * @param {object} eagleItem - Eagle 항목
   * @returns {string|null} 비디오 ID
   */
  extractVideoId(eagleItem) {
    // annotation에서 추출 시도
    const annotationMatch = eagleItem.annotation?.match(/Video ID: ([a-zA-Z0-9_-]+)/);
    if (annotationMatch) return annotationMatch[1];

    // URL에서 추출 시도
    const urlMatch = eagleItem.website?.match(
      /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/
    );
    return urlMatch ? urlMatch[1] : null;
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
}

// 모듈 내보내기
module.exports = LibraryMaintenance; 