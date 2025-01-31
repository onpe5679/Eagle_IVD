// js/downloader.js
const { spawn } = require("child_process");
const fs = require("fs").promises;
const path = require("path");

class Downloader {
    constructor(pluginPath, updateStatusUI, updateCommandPreview, updateProgress) {
        this.downloadFolder = path.join(pluginPath, "downloads");
        this.isDownloading = false;
        this.currentProcess = null;
        this.ytDlpPath = process.platform === "win32"
            ? path.join(pluginPath, "yt-dlp.exe")
            : path.join(pluginPath, "yt-dlp");
        this.ffmpegPath = null;
        this.updateStatusUI = updateStatusUI;
        this.updateCommandPreview = updateCommandPreview;
        this.updateProgress = updateProgress;
        this.pluginPath = pluginPath;
    }

    async initialize() {
        try {
            this.ffmpegPath = await this.getFFmpegPath();
            await this.initializeFolder();
        } catch (error) {
            console.error("Failed to initialize download manager:", error);
            this.updateStatusUI(`Error: Failed to initialize. ${error.message}`);
            throw error;
        }
    }

    async initializeFolder() {
        try {
            await fs.mkdir(this.downloadFolder, { recursive: true });
            console.log("Download folder ready:", this.downloadFolder);
        } catch (error) {
            console.error("Failed to create download folder:", error);
            throw error;
        }
    }

    async startDownload(url, format, quality, speedLimit, concurrency) {
        if (this.isDownloading) {
            throw new Error("Download already in progress");
        }

        this.isDownloading = true;
        this.updateStatusUI("Starting download...");

        const playlistId = this.getPlaylistId(url);
        const tempFolder = playlistId
            ? path.join(this.downloadFolder, playlistId)
            : this.downloadFolder;

        try {
            await fs.mkdir(tempFolder, { recursive: true });
            console.log("Temp download folder ready:", tempFolder);
        } catch (error) {
            console.error("Failed to create temp download folder:", error);
            this.isDownloading = false;
            throw error;
        }

        const args = this.constructArgs(
            url,
            format,
            quality,
            speedLimit,
            concurrency,
            tempFolder
        );

        return new Promise((resolve, reject) => {
            this.currentProcess = spawn(this.ytDlpPath, args);
            this.updateCommandPreview(this.ytDlpPath, args);

            let downloadedFilePath = null; // 다운로드된 파일 경로를 저장할 변수

            this.currentProcess.stdout.on("data", (data) => {
                const output = data.toString();
                console.log("yt-dlp stdout:", output);
                this.updateProgress(output);

                // yt-dlp stdout에서 [Merge] 라인 또는 Destination 라인을 찾아 다운로드된 파일 경로 파싱
                const mergeLine = output.match(/\[Merger\] Merging formats into "(.+)"/);
                const destinationLine = output.match(/\[download\] Destination: (.+)/);
                if (mergeLine) {
                    downloadedFilePath = mergeLine[1]; // [Merge] 라인에서 파일 경로 추출
                } else if (destinationLine) {
                    downloadedFilePath = destinationLine[1]; // Destination 라인에서 파일 경로 추출
                }
            });

            this.currentProcess.stderr.on("data", (data) => {
                const errorOutput = data.toString();
                console.error("yt-dlp stderr:", errorOutput);
                this.updateStatusUI(`Error: ${errorOutput}`);
            });

            this.currentProcess.on("close", async (code) => {
                this.isDownloading = false;
                this.currentProcess = null;

                if (code === 0) {
                    this.updateStatusUI("Adding to Eagle Library...");

                    try {
                        if (!downloadedFilePath) {
                            throw new Error("Downloaded file path not found.");
                        }

                        // Eagle 라이브러리에 파일 추가
                        const item = await eagle.item.addFromPath(downloadedFilePath);
                        console.log("File added to Eagle Library. Item ID:", item.id);
                        this.updateStatusUI("Added to Eagle Library!");

                        // 로컬 파일 삭제 (Eagle 라이브러리 추가 성공 후)
                        try {
                            await fs.unlink(downloadedFilePath);
                            console.log(`Removed local file: ${downloadedFilePath}`);
                        } catch (deleteError) {
                            console.error("Failed to delete local file:", deleteError);
                            this.updateStatusUI(`Warning: Failed to delete local file: ${deleteError.message}`);
                        }

                        if (playlistId) {
                            try {
                                await fs.rm(tempFolder, { recursive: true, force: true });
                                console.log(`Removed temp folder: ${tempFolder}`);
                            } catch (error) {
                                console.error(`Failed to remove temp folder: ${tempFolder}`, error);
                            }
                        }

                        resolve();
                    } catch (error) {
                        console.error("Failed to add to Eagle library or delete local file:", error);
                        this.updateStatusUI(`Error: ${error.message}`);
                        reject(error);
                    }
                } else {
                    reject(new Error(`Download failed with code ${code}`));
                }
            });
        });
    }

    constructArgs(url, format, quality, speedLimit, concurrency, tempFolder) {
        const formatArgs = this.getFormatArgs(format, quality);
        const baseArgs = [
            "--ffmpeg-location",
            this.ffmpegPath,
            "-o",
            path.join(tempFolder, "%(title)s.%(ext)s"),
            "--progress",
            "--no-warnings",
            "--newline",
            url,
        ];

        if (concurrency && concurrency > 1) {
            baseArgs.push("-N", concurrency.toString());
        }
        if (speedLimit) {
            baseArgs.push("--limit-rate", `${speedLimit}K`);
        }

        return [...formatArgs, ...baseArgs];
    }

    getFormatArgs(format, quality) {
        if (format === "best") {
            return ["-f", "bv*+ba/b"];
        }

        if (format === "mp3") {
            return ["-x", "--audio-format", "mp3"];
        }

        let formatString = format;
        if (quality) {
            formatString += `-${quality}`;
        }

        return ["-f", formatString];
    }

    cancel() {
        if (this.currentProcess) {
            this.currentProcess.kill();
            this.isDownloading = false;
            this.currentProcess = null;
            this.updateStatusUI("Download cancelled");
        }
    }

    updateProgress(output) {
        const match = output.match(
            /\[download\]\s+(\d+\.?\d*)%\s+of\s+([\d.]+[KMGT]?iB)\s+at\s+([\d.]+[KMGT]?iB\/s)\s+ETA\s+([\d:]+)/
        );
        if (match) {
            const progress = match[1];
            const fileSize = match[2];
            const speed = match[3];
            const eta = match[4];
            this.updateStatusUI(
                `Progress: ${progress}%, Size: ${fileSize}, Speed: ${speed}, ETA: ${eta}`
            );
        } else {
            this.updateStatusUI(output);
        }
    }

    updateCommandPreview(ytDlpPath, args) {
        const command = `${ytDlpPath} ${args.join(" ")}`;
        this.updateCommandPreview(command);
    }

    async getFFmpegPath() {
        try {
            const ffmpegPaths = await eagle.extraModule.ffmpeg.getPaths();
            console.log("ffmpeg paths:", ffmpegPaths);
            return ffmpegPaths.ffmpeg;
        } catch (error) {
            console.error("Failed to get FFmpeg path:", error);
            throw new Error("Failed to get FFmpeg path");
        }
    }

    async getMetadata(url) {
        const args = [
            "--ffmpeg-location",
            this.ffmpegPath,
            "--print-json",
            "--no-warnings",
            "--skip-download", // 메타데이터만 필요
            "--flat-playlist", // 재생목록도 단일 영상처럼 처리
            "--playlist-end",
            "1", // 재생목록을 단일 영상처럼 취급하기 위해 첫 번째 항목만 가져옴
            url,
        ];

        return new Promise((resolve, reject) => {
            let metadata = "";
            const process = spawn(this.ytDlpPath, args);

            process.stdout.on("data", (data) => {
                metadata += data.toString();
            });

            process.stderr.on("data", (data) => {
                console.error("yt-dlp stderr:", data.toString());
            });

            process.on("close", (code) => {
                if (code === 0) {
                    try {
                        const parsedMetadata = JSON.parse(metadata);
                        resolve(parsedMetadata);
                    } catch (error) {
                        console.error("Failed to parse metadata:", error);
                        console.log("Raw metadata:", metadata);
                        reject(
                            new Error(`Failed to parse metadata: ${error.message}`)
                        );
                    }
                } else {
                    reject(new Error(`yt-dlp exited with code ${code}`));
                }
            });
        });
    }

    getPlaylistId(url) {
        const match = url.match(/list=([a-zA-Z0-9_-]+)/);
        if (match) {
            return match[1];
        }
        return null;
    }

    async getPlaylistMetadata(url) {
        return new Promise((resolve, reject) => {
            const args = [
                "--flat-playlist",
                "--print-json",
                "--no-warnings",
                "--no-download",
                url,
            ];
            let allOutput = "";
            const proc = spawn(this.ytDlpPath, args, { cwd: this.downloadFolder });

            proc.stdout.on("data", (data) => {
                allOutput += data.toString();
            });
            proc.stderr.on("data", (err) => {
                console.error("yt-dlp stderr:", err.toString());
            });
            proc.on("close", (code) => {
                if (code === 0) {
                    try {
                        const lines = allOutput.split("\n").filter(Boolean);
                        const results = lines.map((line) => JSON.parse(line));
                        resolve(results);
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`getPlaylistMetadata exited with code ${code}`));
                }
            });
        });
    }
}

export default Downloader;