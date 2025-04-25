/**
 * 유틸리티 모듈
 * 공통 헬퍼 함수들을 모아놓은 모듈
 */

const fs = require("fs").promises;
const path = require("path");

/**
 * FFmpeg 경로 가져오기
 * @returns {Promise<string>} FFmpeg 실행 파일 경로
 */
async function getFFmpegPath() {
  try {
    const ffmpegPaths = await eagle.extraModule.ffmpeg.getPaths();
    console.log("ffmpeg paths:", ffmpegPaths);
    return ffmpegPaths.ffmpeg;
  } catch (error) {
    console.error("Failed to get FFmpeg path:", error);
    throw new Error("Failed to get FFmpeg path");
  }
}

/**
 * URL에서 YouTube 비디오 ID 추출
 * @param {string} url - YouTube 비디오 URL
 * @returns {string|null} 비디오 ID
 */
function getYoutubeVideoId(url) {
  // 더 범용적인 정규식으로 교체 (언더바 포함 및 길이 유연성)
  const videoIdRegex =
    /(?:v=|v\/|embed\/|watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11,})/; // 11자리 이상 허용
  const match = url.match(videoIdRegex);
  return match ? match[1] : null;
}

/**
 * URL에서 재생목록 ID 추출
 * @param {string} url - 비디오 또는 재생목록 URL
 * @returns {string|null} 재생목록 ID
 */
function getPlaylistId(url) {
  const match = url.match(/list=([a-zA-Z0-9_-]+)/);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * 디렉토리 존재 확인 및 생성
 * @param {string} directory - 확인할 디렉토리 경로
 * @returns {Promise<void>}
 */
async function ensureDirectoryExists(directory) {
  try {
    await fs.mkdir(directory, { recursive: true });
    console.log(`Directory created or already exists: ${directory}`);
  } catch (error) {
    console.error(`Failed to create directory ${directory}:`, error);
    throw error;
  }
}

/**
 * 디렉토리 삭제
 * @param {string} directory - 삭제할 디렉토리 경로
 * @returns {Promise<void>}
 */
async function removeDirectory(directory) {
  try {
    await fs.rm(directory, { recursive: true, force: true });
    console.log(`Removed directory: ${directory}`);
  } catch (error) {
    console.error(`Failed to remove directory ${directory}:`, error);
    throw error;
  }
}

/**
 * yt-dlp를 사용하여 YouTube 비디오 제목 가져오기
 * @param {string} url - 비디오 URL
 * @param {string} ytDlpPath - yt-dlp 실행 파일 경로
 * @returns {Promise<string>} 비디오 제목
 */
async function getYoutubeVideoTitle(url, ytDlpPath) {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const ytDlpProcess = spawn(ytDlpPath, [
      "--get-title",
      url,
    ]);
    let title = "";

    ytDlpProcess.stdout.on("data", (data) => {
      title += data.toString();
    });

    ytDlpProcess.stderr.on("data", (data) => {
      console.error("yt-dlp stderr:", data.toString());
    });

    ytDlpProcess.on("close", (code) => {
      if (code === 0) {
        resolve(title.trim());
      } else {
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });
  });
}

/**
 * YouTube 썸네일 URL 생성
 * @param {string} videoId - 비디오 ID
 * @returns {string} 썸네일 URL
 */
function getYoutubeThumbnailUrl(videoId) {
  return `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
}

/**
 * 날짜 포맷팅
 * @param {number} timestamp - 타임스탬프 (밀리초)
 * @returns {string} 형식화된 날짜 문자열
 */
function formatDate(timestamp) {
  if (!timestamp) return 'N/A';
  return new Date(timestamp).toLocaleString();
}

/**
 * 파일 이름에서 유효하지 않은 문자 제거
 * @param {string} filename - 원본 파일 이름
 * @returns {string} 정제된 파일 이름
 */
function sanitizeFilename(filename) {
  return filename.replace(/[/\\?%*:|"<>]/g, '_');
}

// 모듈 내보내기
module.exports = {
  getFFmpegPath,
  getYoutubeVideoId,
  getPlaylistId,
  ensureDirectoryExists,
  removeDirectory,
  getYoutubeVideoTitle,
  getYoutubeThumbnailUrl,
  formatDate,
  sanitizeFilename
}; 