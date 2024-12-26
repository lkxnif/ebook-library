import { BaseReader } from './BaseReader.js';
import { ERROR_CODES } from '../utils/ErrorHandler.js';

/**
 * EPUB 阅读器类
 * 负责处理 EPUB 格式的电子书
 * @extends BaseReader
 */
export class EPUBReader extends BaseReader {
    /**
     * 创建 EPUB 阅读器实例
     * @param {HTMLElement} container - 渲染容器
     */
    constructor(container) {
        super(container);
        this.book = null;
        this.rendition = null;
        this.currentLocation = 0;
        this.totalLocations = 0;
        this.scrollTimeout = null;

        // 设置容器样式
        this.container.style.position = 'relative';
        this.container.style.width = '100%';
        this.container.style.height = '100%';
        this.container.style.overflow = 'auto';
        this.container.style.backgroundColor = '#f0f0f0';
    }

    /**
     * 加载 EPUB 内容
     * @param {Blob} blob - EPUB 文件的 Blob 对象
     * @returns {Promise<void>}
     */
    async load(blob) {
        try {
            this.emit('loading', { message: '正在加载电子书...' });

            // 创建 EPUB 实例
            this.book = ePub(blob);
            await this.book.ready;

            // 生成位置信息
            await this.book.locations.generate(2048);
            this.totalLocations = this.book.locations.length();

            // 创建渲染器，使用更适合阅读的配置
            this.rendition = this.book.renderTo(this.container, {
                width: '100%',
                height: '100%',
                spread: 'none',
                flow: 'scrolled-doc',
                allowScriptedContent: true,
                manager: 'continuous',
                snap: false,
                // 启用虚拟化渲染
                virtualize: true,
                // 预加载前后各2页
                preloadPages: 2
            });

            // 设置基本样式
            this.rendition.themes.default({
                'body': {
                    'padding': '20px 15%',
                    'max-width': '100%',
                    'margin': '0 auto',
                    'font-family': 'system-ui, -apple-system, sans-serif',
                    'line-height': '1.8',
                    'background-color': 'var(--reader-background)',
                    'color': 'var(--reader-text)',
                    'text-align': 'justify',
                    'column-gap': '40px',  // 页面间距
                    'column-fill': 'auto'  // 允许内容自动分列
                },
                'p': {
                    'margin-bottom': '1em',
                    'text-indent': '2em',
                    'color': 'var(--reader-text)'
                },
                'a': {
                    'color': 'var(--reader-link)',
                    'text-decoration': 'none'
                },
                'a:hover': {
                    'color': 'var(--reader-link-hover)',
                    'text-decoration': 'underline'
                },
                'h1, h2, h3, h4, h5, h6': {
                    'color': 'var(--reader-heading)',
                    'margin-bottom': '0.5em'
                },
                'img': {
                    'max-width': '100%',
                    'height': 'auto',
                    'display': 'block',
                    'margin': '1em auto',
                    'filter': 'var(--reader-image-filter)'
                },
                '@media screen and (max-width: 800px)': {
                    'body': {
                        'padding': '20px 5%'
                    }
                }
            });

            // 监听渲染器事件
            this.rendition.on('rendered', (section) => {
                console.log('页面渲染完成:', section.href);
                this._handleRendered(section);
                // 预加载下一页
                this._preloadNextPages();
            });

            // 监听位置变化
            this.rendition.on('relocated', location => {
                this.currentLocation = this.book.locations.locationFromCfi(location.start.cfi);
                this.emit('pageChanged', {
                    pageNumber: this.currentLocation,
                    totalPages: this.totalLocations
                });
            });

            // 显示内容
            await this.rendition.display();

            // 获取元数据
            const metadata = await this.book.loaded.metadata;

            // 触发加载完成事件
            this.emit('loaded', {
                title: metadata.title || '未命名文档',
                totalPages: this.totalLocations,
                metadata: metadata
            });

            // 加载目录
            const navigation = await this.book.loaded.navigation;
            this.emit('tocLoaded', {
                toc: navigation.toc
            });

            // 初始化事件监听和功能
            this.initializeEventListeners();

        } catch (error) {
            console.error('EPUB加载失败:', error);
            this.handleError(error);
            throw error;
        }
    }

    /**
     * 预加载页面
     * @private
     */
    async _preloadNextPages() {
        try {
            const nextPages = [];
            // 预加载后面2页
            for (let i = 1; i <= 2; i++) {
                const nextLocation = this.currentLocation + i;
                if (nextLocation <= this.totalLocations) {
                    const cfi = this.book.locations.cfiFromLocation(nextLocation - 1);
                    if (cfi) {
                        nextPages.push(this.rendition.preload(cfi));
                    }
                }
            }
            // 预加载前面1页
            if (this.currentLocation > 1) {
                const prevLocation = this.currentLocation - 1;
                const cfi = this.book.locations.cfiFromLocation(prevLocation - 1);
                if (cfi) {
                    nextPages.push(this.rendition.preload(cfi));
                }
            }
            await Promise.all(nextPages);
            console.log('预加载完成');
        } catch (error) {
            console.warn('预加载页面时出错:', error);
        }
    }

    /**
     * 跳转到指定位置
     * @param {number} location - 位置编号
     */
    goToLocation(location) {
        console.log('跳转到位置:', location);
        if (location >= 1 && location <= this.totalLocations) {
            // 由于epub.js的位置是从0开始的，需要减1
            const cfi = this.book.locations.cfiFromLocation(location - 1);
            if (cfi) {
                // 设置一个标志，表示这是主动跳转
                this._isManualJump = true;
                this.rendition.display(cfi).then(() => {
                    this._isManualJump = false;
                    // 预加载新的页面
                    this._preloadNextPages();
                });

                // 立即更新UI，不等待位置变更事件
                this.currentLocation = location;
                this.updateUI(location);
            }
        }
    }

    /**
     * 更新UI显示
     * @private
     * @param {number} location - 当前位置
     */
    updateUI(location) {
        // 更新进度条值
        const progress = document.getElementById('progress');
        if (progress) {
            progress.value = String(location);
            console.log('更新进度条值:', progress.value);
        }

        // 更新页码显示
        document.getElementById('page-info').textContent = `${location}/${this.totalLocations}`;
    }

    /**
     * 跳转到上一页
     */
    prev() {
        console.log('上一页 - 当前位置:', this.currentLocation);
        if (this.currentLocation > 1) {
            // 使用epub.js的原生prev方法
            this._isManualJump = true;
            this.rendition.prev().then(() => {
                this._isManualJump = false;
                // 预加载新的页面
                this._preloadNextPages();
            });
        }
    }

    /**
     * 跳转到下一页
     */
    next() {
        console.log('下一页 - 当前位置:', this.currentLocation);
        if (this.currentLocation < this.totalLocations) {
            // 使用epub.js的原生next方法
            this._isManualJump = true;
            this.rendition.next().then(() => {
                this._isManualJump = false;
                // 预加载新的页面
                this._preloadNextPages();
            });
        }
    }

    /**
     * 跳转到指定章节
     * @param {string} href - 章节链接
     */
    async goToChapter(href) {
        try {
            console.log('跳转到章节:', href);
            if (this.rendition) {
                await this.rendition.display(href);
                this.updateCurrentLocation();
            }
        } catch (error) {
            console.error('跳转章节失败:', error);
            this.handleError(error);
        }
    }

    /**
     * 更新当前位置信息
     * @private
     */
    async updateCurrentLocation() {
        try {
            const location = await this.rendition.currentLocation();
            if (location) {
                const currentPage = this.book.locations.locationFromCfi(location.start.cfi);
                this.currentPage = currentPage;
                this.emit('pageChanged', {
                    pageNumber: currentPage,
                    totalPages: this.totalLocations
                });
            }
        } catch (error) {
            console.error('更新位置信息失败:', error);
        }
    }

    /**
     * 设置主题
     * @param {Object} theme - 主题样式
     */
    setTheme(theme) {
        if (theme?.body) {
            const isDark = theme.body.background === '#222222';

            // 定义主题样式
            const styles = this._createThemeStyles(theme, isDark);

            // 更新渲染器主题
            if (this.rendition) {
                this.rendition.themes.default(styles);
                // 强制重新应用主题
                this.rendition.themes.select('default');
            }

            // 更新容器背景色
            this.container.style.backgroundColor = isDark ? '#1a1a1a' : '#f0f0f0';

            // 更新 iframe 背景色
            const iframe = this.container.querySelector('iframe');
            if (iframe) {
                iframe.style.backgroundColor = theme.body.background;
            }

            // 触发主题变更事件
            this.emit('themeChanged', { theme, isDark });
        }
    }

    /**
     * 创建主题样式
     * @private
     * @param {Object} theme - 主题配置
     * @param {boolean} isDark - 是否为暗黑模式
     * @returns {Object} 样式对象
     */
    _createThemeStyles(theme, isDark) {
        return {
            'body': {
                'color': `${theme.body.color} !important`,
                'background-color': `${theme.body.background} !important`,
                'padding': '20px 15%',
                'max-width': '100%',
                'margin': '0 auto',
                'font-family': 'system-ui, -apple-system, sans-serif',
                'line-height': '1.8'
            },
            'p, div, span': {
                'color': `${theme.body.color} !important`
            },
            'a': {
                'color': `${isDark ? '#6ea8fe' : '#0d6efd'} !important`,
                'text-decoration': 'none'
            },
            'a:hover': {
                'color': `${isDark ? '#9ec5fe' : '#0a58ca'} !important`,
                'text-decoration': 'underline'
            },
            'h1, h2, h3, h4, h5, h6': {
                'color': `${theme.body.color} !important`,
                'margin-bottom': '0.5em'
            },
            'img': {
                'max-width': '100%',
                'height': 'auto',
                'display': 'block',
                'margin': '1em auto',
                'filter': isDark ? 'brightness(0.8)' : 'none'
            },
            'pre, code': {
                'background-color': `${isDark ? '#333333' : '#f8f9fa'} !important`,
                'color': `${theme.body.color} !important`,
                'padding': '0.2em 0.4em',
                'border-radius': '3px'
            },
            'blockquote': {
                'border-left': `4px solid ${isDark ? '#6ea8fe' : '#0d6efd'} !important`,
                'padding-left': '1em',
                'margin-left': '0',
                'color': `${theme.body.color} !important`
            },
            'table': {
                'border-color': `${isDark ? '#444444' : '#dee2e6'} !important`
            },
            'th, td': {
                'border-color': `${isDark ? '#444444' : '#dee2e6'} !important`,
                'color': `${theme.body.color} !important`
            },
            '@media screen and (max-width: 800px)': {
                'body': {
                    'padding': '20px 5%'
                }
            }
        };
    }

    /**
     * 设置字体大小
     * @param {string} size - 字体大小（'small' | 'medium' | 'large'）
     */
    setFontSize(size) {
        console.log('设置字体大小:', size);
        const sizes = {
            small: { scale: 0.8, percent: '80%' },
            medium: { scale: 1.0, percent: '100%' },
            large: { scale: 1.2, percent: '120%' }
        };

        if (sizes[size] && this.rendition) {
            const { percent } = sizes[size];
            console.log('应用新的字体大小:', percent);

            // 应用字体大小
            this.rendition.themes.fontSize(percent);

            // 触发字体大小变更事件
            this.emit('fontSizeChanged', { size, percent });
        }
    }

    /**
     * 清理资源
     */
    cleanup() {
        super.cleanup();
        if (this.book) {
            this.book.destroy();
            this.book = null;
        }
        if (this.rendition) {
            this.rendition.destroy();
            this.rendition = null;
        }
        // 移除事件监听器
        this.container.removeEventListener('scroll', this.handleScroll);
        document.removeEventListener('keydown', this.handleKeyDown);
    }

    /**
     * 初始化进度条
     * @private
     */
    initializeProgress() {
        const progress = document.getElementById('progress');
        if (progress) {
            console.log('初始化进度条 - 总页数:', this.totalLocations);

            // 设置进度条范围为1到总页数
            progress.min = "1";
            progress.max = String(this.totalLocations);
            progress.value = String(Math.max(1, this.currentLocation || 1));

            console.log('进度条初始设置 - min:', progress.min, 'max:', progress.max, 'value:', progress.value);

            // 更新页码显示
            document.getElementById('page-info').textContent = `${Math.max(1, this.currentLocation || 1)}/${this.totalLocations}`;

            // 监听进度条拖动
            progress.addEventListener('input', () => {
                // 直接使用进度条的值作为页码
                const targetLocation = Math.max(1, Math.min(
                    parseInt(progress.value) || 1,
                    this.totalLocations
                ));

                console.log('进度条输入值:', progress.value, '目标位置:', targetLocation);

                // 更新当前位置
                this.currentLocation = targetLocation;

                // 更新页码显示
                document.getElementById('page-info').textContent = `${targetLocation}/${this.totalLocations}`;

                // 计算目标滚动位置
                const scrollHeight = this.container.scrollHeight;
                const containerHeight = this.container.clientHeight;
                const maxScroll = scrollHeight - containerHeight;
                const targetScroll = ((targetLocation - 1) / Math.max(1, this.totalLocations - 1)) * maxScroll;

                console.log('滚动位置计算 - 目标位置:', targetLocation, '滚动位置:', targetScroll);

                // 滚动到目标位置
                this.container.scrollTo({
                    top: targetScroll,
                    behavior: 'smooth'
                });

                // 触发页面变化事件
                this.emit('pageChanged', {
                    pageNumber: targetLocation,
                    totalPages: this.totalLocations
                });
            });
        }
    }

    /**
     * 初始化主题
     * @private
     */
    initializeTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        if (currentTheme === 'dark') {
            this.setTheme({
                body: {
                    color: '#ffffff',
                    background: '#222222'
                }
            });
        }
    }

    /**
     * 初始化事件监听
     * @private
     */
    initializeEventListeners() {
        super.initializeEventListeners();

        // 键盘事件监听
        this.handleKeyDown = (event) => {
            switch (event.key) {
                case 'ArrowLeft':
                case 'PageUp':
                    event.preventDefault();
                    this.prev();
                    break;
                case 'ArrowRight':
                case 'PageDown':
                case ' ':  // 空格键
                    event.preventDefault();
                    this.next();
                    break;
                case 'Home':
                    event.preventDefault();
                    this.goToLocation(0);
                    break;
                case 'End':
                    event.preventDefault();
                    if (this.book && this.book.locations && this.book.locations.length()) {
                        this.goToLocation(this.book.locations.length() - 1);
                    }
                    break;
            }
        };
        document.addEventListener('keydown', this.handleKeyDown);

        // 监听渲染器事件
        if (this.rendition) {
            // 监听渲染完成事件
            this.rendition.on('rendered', this._handleRendered.bind(this));
            // 监听位置变更事件
            this.rendition.on('relocated', this._handleRelocated.bind(this));
        }
    }

    /**
     * 处理渲染完成事件
     * @private
     */
    _handleRendered(section) {
        try {
            if (section.start && section.start.cfi) {
                const currentLocation = Math.max(1, this.book.locations.locationFromCfi(section.start.cfi) + 1);
                console.log('渲染完成 - 当前位置:', currentLocation);

                if (typeof currentLocation === 'number' && currentLocation !== this.currentLocation) {
                    this.currentLocation = currentLocation;
                    this.updateUI(currentLocation);

                    this.emit('pageChanged', {
                        pageNumber: currentLocation,
                        totalPages: this.totalLocations || this.book.spine.length
                    });
                }
            }
        } catch (error) {
            console.warn('处理渲染事件时出错:', error);
        }
    }

    /**
     * 处理位置变更事件
     * @private
     */
    _handleRelocated(location) {
        try {
            if (location.start && location.start.cfi) {
                // epub.js的位置是从0开始的，需要加1来匹配我们的页码
                const currentLocation = Math.max(1, this.book.locations.locationFromCfi(location.start.cfi) + 1);
                console.log('位置变更事件 - 新位置:', currentLocation, '是否主动跳转:', this._isManualJump);

                // 更新位置和UI（无论是否是主动跳转）
                if (typeof currentLocation === 'number' && currentLocation !== this.currentLocation) {
                    this.currentLocation = currentLocation;
                    this.updateUI(currentLocation);

                    // 触发页面变化事件
                    this.emit('pageChanged', {
                        pageNumber: currentLocation,
                        totalPages: this.totalLocations
                    });
                }
            }
        } catch (error) {
            console.warn('处理位置变更事件时出错:', error);
            // 使用备用方法计算位置
            if (location.start && location.start.percentage) {
                const targetLocation = Math.max(1, Math.min(
                    Math.round(location.start.percentage * this.totalLocations),
                    this.totalLocations
                ));
                console.log('使用百分比计算位置:', location.start.percentage, '目标位置:', targetLocation);

                if (targetLocation !== this.currentLocation) {
                    this.currentLocation = targetLocation;
                    this.updateUI(targetLocation);

                    // 触发页面变化事件
                    this.emit('pageChanged', {
                        pageNumber: targetLocation,
                        totalPages: this.totalLocations
                    });
                }
            }
        }
    }

    handleScroll() {
        if (this.scrollTimeout) {
            clearTimeout(this.scrollTimeout);
        }

        this.scrollTimeout = setTimeout(() => {
            const containerHeight = this.container.clientHeight;
            const scrollTop = this.container.scrollTop;
            const scrollHeight = this.container.scrollHeight;
            const maxScroll = scrollHeight - containerHeight;

            console.log('滚动事件 - scrollTop:', scrollTop, 'maxScroll:', maxScroll);

            // 检查是否滚动到底部
            const isAtBottom = Math.ceil(scrollTop) >= maxScroll || Math.abs(maxScroll - scrollTop) < 1;

            let targetLocation;
            if (isAtBottom) {
                // 如果滚动到底部，设置为最后一页
                targetLocation = this.totalLocations;
                console.log('滚动到底部，设置为最后一页:', targetLocation);
            } else {
                // 根据滚动位置计算当前页码
                const scrollPercentage = scrollTop / maxScroll;
                targetLocation = Math.max(1, Math.min(
                    Math.round(scrollPercentage * (this.totalLocations - 1)) + 1,
                    this.totalLocations
                ));
                console.log('根据滚动计算页码 - 百分比:', scrollPercentage, '目标页码:', targetLocation);
            }

            // 只有当位置真正改变时才更新
            if (targetLocation !== this.currentLocation) {
                console.log('位置发生变化 - 从:', this.currentLocation, '到:', targetLocation);
                this.currentLocation = targetLocation;

                // 更新进度条值
                const progress = document.getElementById('progress');
                if (progress) {
                    progress.value = String(targetLocation);
                    console.log('更新进度条值:', progress.value);
                }

                // 更新页码显示
                document.getElementById('page-info').textContent = `${targetLocation}/${this.totalLocations}`;

                // 触发页面变化事件
                this.emit('pageChanged', {
                    pageNumber: targetLocation,
                    totalPages: this.totalLocations
                });
            }
        }, 100);
    }
} 