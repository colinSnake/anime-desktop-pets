"""紧凑的卡片气泡和菜单；Qt 保留交互，统一绘制圆角、文字和图标。"""
import math
import logging
import sys
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import Qt, QSize, QRectF, QPointF, QPropertyAnimation, QEasingCurve, QTimer
from PySide6.QtGui import (QFontDatabase, QFontMetricsF, QPainter, QColor,
                          QTextOption, QTextCursor, QTextBlockFormat,
                          QPainterPath, QPen, QPalette)
from PySide6.QtWidgets import (QApplication, QWidget, QVBoxLayout, QTextBrowser,
                              QProgressBar, QPushButton, QToolButton, QHBoxLayout,
                              QMenu, QFrame, QLabel, QSizePolicy,
                              QProxyStyle, QStyle, QStyleOptionMenuItem, QStyleFactory,
                              QLayout)

FLAGS = (Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint |
         Qt.WindowType.Tool | Qt.WindowType.NoDropShadowWindowHint)
SHADOW = 6


def card_colors(widget):
    dark = widget.palette().color(QPalette.ColorRole.Window).lightness() < 128
    return dict(dark=dark, text='#f5f5f7' if dark else '#252528',
                muted='#a1a1a8' if dark else '#818187',
                surface='#2c2c30' if dark else '#fafafc',
                border='#55555c' if dark else '#d5d5da',
                separator='#46464d' if dark else '#dfdfe4', accent='#007aff')


def paint_card(painter, bounds, colors, radius=12):
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    card = QRectF(bounds).adjusted(SHADOW, SHADOW, -SHADOW, -SHADOW)
    painter.setPen(Qt.PenStyle.NoPen)
    # 只绘制几层有界阴影，不申请整张模糊纹理，也不叠加平台方形窗口阴影。
    for spread, alpha in ((5, 3), (4, 4), (3, 5), (2, 7), (1, 9)):
        painter.setBrush(QColor(0, 0, 0, alpha))
        painter.drawRoundedRect(card.adjusted(-spread, -spread + 1, spread, spread + 1),
                                radius + spread, radius + spread)
    painter.setBrush(QColor(colors['surface']))
    painter.setPen(QPen(QColor(colors['border']), .65))
    painter.drawRoundedRect(card.adjusted(.4, .4, -.4, -.4), radius, radius)
    return card


def system_font(points=10, bold=False):
    font = QFontDatabase.systemFont(QFontDatabase.SystemFont.GeneralFont)
    font.setPointSizeF(points)
    font.setBold(bold)
    return font


def bubble_font(points=11, bold=False):
    """Prefer the rounded Chinese families used by the reference bubble."""
    installed = set(QFontDatabase.families())
    preferred = ('ShangshouSoftCandy', 'Yuanti SC', 'YouYuan', '幼圆',
                 'Comic Sans MS', 'PingFang SC', 'Microsoft YaHei')
    family = next((name for name in preferred if name in installed), None)
    font = QFontDatabase.systemFont(QFontDatabase.SystemFont.GeneralFont)
    if family:
        font.setFamily(family)
    font.setPointSizeF(points)
    font.setBold(bold)
    return font


_MESSAGE_FONT_CHECKED = False
_MESSAGE_FONT_FAMILY = None


def message_font(points=13):
    """Use the bundled SSRuanTangTi font for ordinary message bubbles."""
    global _MESSAGE_FONT_CHECKED, _MESSAGE_FONT_FAMILY
    if not _MESSAGE_FONT_CHECKED:
        _MESSAGE_FONT_CHECKED = True
        bundle_root = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))
        candidates = (bundle_root / 'fonts/上首软糖体.ttf',
                     Path(__file__).resolve().parent / 'fonts/上首软糖体.ttf')
        for path in candidates:
            if not path.is_file():
                continue
            font_id = QFontDatabase.addApplicationFont(str(path))
            if font_id >= 0:
                _MESSAGE_FONT_FAMILY = next(
                    (family for family in QFontDatabase.applicationFontFamilies(font_id)
                     if family == 'SSRuanTangTi'), None)
                if _MESSAGE_FONT_FAMILY:
                    break
    if _MESSAGE_FONT_FAMILY != 'SSRuanTangTi':
        logging.getLogger(__name__).warning(
            '消息气泡未能加载 SSRuanTangTi；请用 --local-test-font 构建本机测试版')
        return bubble_font(points)
    font = bubble_font(points)
    font.setFamily('SSRuanTangTi')
    return font


class RefreshButton(QToolButton):
    """Compact circular refresh control with a theme-aware custom glyph."""
    def __init__(self, color, parent=None):
        super().__init__(parent)
        self.glyph_color = QColor(color)
        self.setAutoRaise(True)
        self.setFixedSize(26, 26)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setToolTip('重新查询额度')
        self.setAccessibleName('重新查询额度')

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        if self.underMouse() or self.isDown():
            painter.setPen(Qt.PenStyle.NoPen)
            alpha = 38 if self.isDown() else 24
            painter.setBrush(QColor(self.glyph_color.red(), self.glyph_color.green(),
                                    self.glyph_color.blue(), alpha))
            painter.drawEllipse(QRectF(1, 1, 24, 24))
        pen = QPen(self.glyph_color, 1.65, Qt.PenStyle.SolidLine,
                   Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        path = QPainterPath(QPointF(19, 7))
        path.lineTo(19, 11)
        path.lineTo(15, 11)
        path.moveTo(5, 17)
        path.lineTo(5, 13)
        path.lineTo(9, 13)
        path.moveTo(5, 7)
        path.cubicTo(7.8, 3.7, 13, 3.3, 16.3, 6.2)
        path.lineTo(19, 7)
        path.moveTo(19, 17)
        path.cubicTo(16.2, 20.3, 11, 20.7, 7.7, 17.8)
        path.lineTo(5, 17)
        painter.drawPath(path)


class FittedText(QTextBrowser):
    """先按最终宽度测量文字，再决定高度；只在超过阅读预算时滚动。"""
    def __init__(self, text='', parent=None, cap=168, line_height=160):
        super().__init__(parent)
        self.cap = self.preferred_cap = cap
        self.line_height = line_height
        self.text_alignment = Qt.AlignmentFlag.AlignLeft
        self._fitting = False
        self._measure_width = 240
        self.setFont(bubble_font())
        self.setFrameShape(QFrame.Shape.NoFrame)
        self.setOpenLinks(False)
        self.setOpenExternalLinks(False)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
        option = self.document().defaultTextOption()
        option.setWrapMode(QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere)
        self.document().setDefaultTextOption(option)
        self.document().setDocumentMargin(0)
        self.document().setDefaultFont(self.font())
        self.setStyleSheet('QTextBrowser {background:transparent;border:0;padding:0;}')
        self.document().contentsChanged.connect(self.fit)
        self.setPlainText(text)

    def setText(self, text):
        self.setPlainText(text)

    def setPlainText(self, text):
        super().setPlainText(text)
        cursor = QTextCursor(self.document())
        cursor.select(QTextCursor.SelectionType.Document)
        block = QTextBlockFormat()
        block.setLineHeight(self.line_height, QTextBlockFormat.LineHeightTypes.ProportionalHeight.value)
        block.setAlignment(self.text_alignment)
        cursor.mergeBlockFormat(block)
        self.fit()

    def set_text_alignment(self, alignment):
        self.text_alignment = alignment
        cursor = QTextCursor(self.document())
        cursor.select(QTextCursor.SelectionType.Document)
        block = QTextBlockFormat()
        block.setAlignment(alignment)
        cursor.mergeBlockFormat(block)
        self.fit()

    def fit(self, width=None):
        if self._fitting:
            return
        self._fitting = True
        try:
            if width is not None:
                self._measure_width = max(24, int(width))
            width = self._measure_width
            self.document().setTextWidth(width)
            needed = math.ceil(self.document().size().height()) + 1
            if needed > self.cap:
                # 保留滚动条的宽度，长路径不会被右侧滚动条覆盖。
                extent = self.style().pixelMetric(QStyle.PixelMetric.PM_ScrollBarExtent)
                self.document().setTextWidth(max(24, width - extent))
                needed = math.ceil(self.document().size().height()) + 1
            minimum = math.ceil(QFontMetricsF(self.font()).height() * self.line_height / 100) + 1
            height = min(self.cap, max(minimum, needed))
            self.setFixedSize(width, height)
        finally:
            self._fitting = False

    def sizeHint(self):
        return QSize(self._measure_width, self.height())


class Bubble(QWidget):
    def __init__(self):
        super().__init__(None, FLAGS)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        if sys.platform == 'darwin':
            self.setAttribute(Qt.WidgetAttribute.WA_MacAlwaysShowToolWindow)
        self.layout = QVBoxLayout(self)
        self.layout.setSizeConstraint(QLayout.SizeConstraint.SetNoConstraint)
        # 6px 阴影 + 卡片内部左右 10px、上下 8px。
        self.layout.setContentsMargins(16, 14, 16, 14)
        self.layout.setSpacing(6)
        self.is_followed_work = False
        self.is_speech_reply = False
        self.is_task_progress = self.is_quota_result = False
        self.kind = 'message'
        self.speech_callback = None
        self._pending_speech = None
        self.speech_timer = QTimer(self)
        self.speech_timer.setSingleShot(True)
        self.speech_timer.timeout.connect(self.flush_speech)
        self.preferred_width = 260
        self.text_cap = 168
        self.fade = QPropertyAnimation(self, b'windowOpacity', self)
        self.fade.setDuration(90)
        self.fade.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.setFont(bubble_font())

    def available_area(self):
        # PySide6 6.9 的 QWidget.screen() 返回值父级启发式会把共享 QScreen
        # 挂到此气泡的包装器下；气泡销毁时连带使屏幕包装器失效。
        # 应用级查询不建立该所有权关联，并沿用角色按窗口中心选屏的约定。
        screen = (QApplication.screenAt(self.frameGeometry().center()) or
                  QApplication.primaryScreen())
        return screen.availableGeometry()

    def configure_width(self, preferred):
        self.preferred_width = preferred
        area = self.available_area()
        self.text_cap = max(40, min(168, int(area.height() * .32)))

    def _views(self):
        return [self.layout.itemAt(i).widget() for i in range(self.layout.count())
                if isinstance(self.layout.itemAt(i).widget(), FittedText)]

    def fit_to_area(self, area):
        self._reflow(area)

    def _reflow(self, area):
        views = self._views()
        if not views:
            return
        self.layout.setContentsMargins(16, 14, 16, 14)
        margins = self.layout.contentsMargins()
        outer = margins.left() + margins.right()
        natural = max((QFontMetricsF(v.font()).horizontalAdvance(line)
                       for v in views for line in v.toPlainText().splitlines()), default=0)
        minimum = 252 if self.kind == 'quota' else 180 if self.kind == 'result' else 128
        width = min(area.width() - 24, max(minimum, min(self.preferred_width, math.ceil(natural) + outer + 3)))
        width = max(80, width)
        chrome = margins.top() + margins.bottom() + self.layout.spacing() * max(0, self.layout.count() - 1)
        for i in range(self.layout.count()):
            widget = self.layout.itemAt(i).widget()
            if not isinstance(widget, FittedText):
                chrome += widget.sizeHint().boundedTo(widget.maximumSize()).expandedTo(widget.minimumSize()).height()
        line_heights = [math.ceil(QFontMetricsF(v.font()).height() * v.line_height / 100) + 1
                        for v in views]
        budget = max(sum(line_heights), min(264, area.height() - 24) - chrome)
        # 短标题实际用多少算多少，不按最大高度占位；优先把空间留给正文。
        remaining = budget
        for i, view in enumerate(views):
            reserve = sum(line_heights[i + 1:])
            view.cap = max(line_heights[i], min(view.preferred_cap, remaining - reserve))
            view.fit(width - outer)
            remaining -= view.height()
        if self.kind == 'message' and len(views) == 1:
            view = views[0]
            if view.document().size().height() <= view.height():
                # Qt places the extra proportional line leading below the glyphs.
                # Offset only the short-message viewport; keep the total margins unchanged.
                optical_offset = min(8, round(QFontMetricsF(view.font()).height() * .4))
                self.layout.setContentsMargins(16, 14 + optical_offset,
                                               16, 14 - optical_offset)
        height = chrome + sum(v.height() for v in views)
        self.setFixedSize(width, height)
        self.layout.activate()
        self.update()

    def showEvent(self, event):
        super().showEvent(event)
        from desktop_visibility import configure_macos_window
        if QApplication.platformName() == 'cocoa':
            configure_macos_window(int(self.winId()))
            if not reduced_motion():
                self.setWindowOpacity(0)
                self.fade.setStartValue(0.0)
                self.fade.setEndValue(1.0)
                self.fade.start()

    def hideEvent(self, event):
        self.speech_timer.stop()
        self._pending_speech = None
        self.fade.stop()
        self.setWindowOpacity(1)
        super().hideEvent(event)

    def paintEvent(self, event):
        painter = QPainter(self)
        paint_card(painter, self.rect(), card_colors(self))

    def clear(self):
        while self.layout.count():
            widget = self.layout.takeAt(0).widget()
            if widget is not None:
                widget.hide()
                widget.setParent(None)
                widget.deleteLater()

    def label(self, text, cap=None, title=False, muted=False, line_height=160):
        label = FittedText(text, self, cap=cap or self.text_cap, line_height=line_height)
        if title:
            label.setFont(bubble_font(11, bold=True))
            label.document().setDefaultFont(label.font())
        palette = label.palette()
        colors = card_colors(self)
        palette.setColor(QPalette.ColorRole.Text, QColor(colors['muted'] if muted else colors['text']))
        label.setPalette(palette)
        self.layout.addWidget(label)
        return label

    def finish(self):
        area = self.available_area()
        self._reflow(area)
        self.show()

    def announce(self, text, *, speak=True):
        if not speak or self.is_speech_reply or self.speech_callback is None:
            self.speech_timer.stop()
            self._pending_speech = None
            return
        self._pending_speech = text
        self.speech_timer.start(300)

    def flush_speech(self):
        if self._pending_speech is None:
            return
        if not self.isVisible():
            self._pending_speech = None
            return
        if (QApplication.activeModalWidget() is not None or
                QApplication.activePopupWidget() is not None):
            self.speech_timer.start(250)
            return
        text, self._pending_speech = self._pending_speech, None
        callback = self.speech_callback
        if callback is not None and not self.is_speech_reply:
            try:
                callback(text)
            except Exception:
                pass

    def message(self, text, *, speak=True):
        self.kind = 'message'
        self.is_followed_work = False
        self.is_speech_reply = False
        self.is_task_progress = self.is_quota_result = False
        self.configure_width(284)
        self.clear()
        self.result_view = self.label(text)
        self.result_view.set_text_alignment(Qt.AlignmentFlag.AlignHCenter)
        self.result_view.setFont(message_font())
        self.result_view.document().setDefaultFont(self.result_view.font())
        self.result_view.fit()
        self.finish()
        self.announce(text, speak=speak)

    def task_result(self, title, text, details):
        self.kind = 'result'
        self.is_followed_work = False
        self.is_speech_reply = False
        self.is_task_progress = False
        self.is_quota_result = True
        self.configure_width(316)
        self.clear()
        self.result_title = self.label(title, cap=42, title=True, line_height=125)
        self.result_title.set_text_alignment(Qt.AlignmentFlag.AlignLeft)
        self.result_view = self.label(text, cap=168, line_height=130)
        button = QPushButton('详情', self)
        button.setAccessibleName('详情')
        button.setFont(bubble_font(9))
        colors = card_colors(self)
        button.setStyleSheet('QPushButton {color:'+colors['accent']+';background:transparent;'
                             'border:0;border-radius:5px;padding:3px 6px;}'
                             'QPushButton:hover {background:rgba(0,122,255,20);}')
        button.clicked.connect(lambda checked=False: details())
        self.layout.addWidget(button, 0, Qt.AlignmentFlag.AlignRight)
        self.finish()
        self.announce(title + '。' + text)

    def quota(self, windows, refreshed_at=None, refresh=None):
        self.kind = 'quota'
        self.is_followed_work = False
        self.is_speech_reply = False
        self.is_task_progress = False
        self.is_quota_result = True
        is_balance = any(w.get('kind') == 'balance' for w in windows)
        self.configure_width(316 if is_balance else 320)
        self.clear()
        colors = card_colors(self)
        header = QWidget(self)
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(0, 0, 0, 0)
        header_layout.setSpacing(6)
        title = QLabel('中转余额' if is_balance else '额度', header)
        title.setFont(bubble_font(11, bold=True))
        title.setStyleSheet('color:'+colors['text']+';')
        header_layout.addWidget(title)
        header_layout.addStretch(1)
        if refresh is not None:
            button = RefreshButton(colors['accent'], header)
            button.clicked.connect(lambda checked=False: refresh())
            header_layout.addWidget(button)
        self.layout.addWidget(header)
        self.layout.addWidget(self.separator())
        if is_balance:
            window = next(w for w in windows if w.get('kind') == 'balance')
            amount = FittedText(f"{window['remaining']:,.2f}", self, cap=52, line_height=115)
            amount.setFont(bubble_font(25, bold=True))
            amount.document().setDefaultFont(amount.font())
            amount.setPalette(self.palette())
            amount.setStyleSheet('QTextBrowser {color:'+colors['accent']+';background:transparent;border:0;padding:0;}')
            self.layout.addWidget(amount)
            footer = QWidget(self)
            footer.setObjectName('quotaBalanceFooter')
            footer_layout = QHBoxLayout(footer)
            footer_layout.setContentsMargins(0, 0, 0, 0)
            footer_layout.setSpacing(8)
            source = QLabel(f"{window['name']} · {window['unit']}", footer)
            source.setObjectName('quotaBalanceSource')
            source.setFont(bubble_font(9))
            source.setStyleSheet('color:'+colors['muted']+';')
            source.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
            source.setToolTip(source.text())
            footer_layout.addWidget(source, 1)
            if refreshed_at:
                queried = QLabel('查询于 ' + refreshed_at.strftime('%H:%M'), footer)
                queried.setObjectName('quotaBalanceQueriedAt')
                queried.setFont(bubble_font(9))
                queried.setStyleSheet('color:'+colors['muted']+';')
                queried.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
                footer_layout.addWidget(queried, 0)
            self.layout.addWidget(footer)
            if len(windows) > 1:
                self.label('其他窗口', cap=20, title=True, line_height=140)
        for window in windows:
            if window.get('kind') == 'balance' and is_balance:
                continue
            value = window['remaining']
            row = QWidget(self)
            row_layout = QHBoxLayout(row)
            row_layout.setContentsMargins(0, 0, 0, 0)
            row_layout.setSpacing(4)
            label = QLabel(window['name'], row)
            label.setFont(bubble_font(10))
            label.setStyleSheet('color:'+colors['text']+';')
            label.setMinimumWidth(0)
            label.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
            label.setToolTip(window['name'])
            remaining = QLabel(f"{value:g}% 剩余" if value is not None else '暂未提供', row)
            remaining.setFont(bubble_font(10, bold=True))
            remaining.setStyleSheet('color:'+colors['text']+';')
            remaining.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
            row_layout.addWidget(label, 1)
            row_layout.addWidget(remaining, 0)
            self.layout.addWidget(row)
            bar = QProgressBar(self)
            bar.setRange(0, 100)
            bar.setValue(round(value) if value is not None else 0)
            bar.setTextVisible(False)
            bar.setFixedHeight(7)
            fill = '#35a36f' if value is not None and value >= 60 else '#d69a36' if value is not None and value >= 25 else '#d65c58'
            bar.setStyleSheet('QProgressBar {border:0;border-radius:3px;background:'+colors['separator']+';}'
                              'QProgressBar::chunk {background:'+fill+';border-radius:3px;}')
            self.layout.addWidget(bar)
            if window.get('resetsAt'):
                self.label('重置于 ' + datetime.fromtimestamp(window['resetsAt']).strftime('%m月%d日 %H:%M'), cap=22, muted=True, line_height=140)
        if refreshed_at and not is_balance:
            self.label('查询于 ' + refreshed_at.strftime('%H:%M'), cap=20, muted=True, line_height=140)
        self.finish()
        try:
            if is_balance:
                window = next(w for w in windows if w.get('kind') == 'balance')
                unit = str(window.get('unit', '')).strip()
                spoken_unit = {
                    'USD': '美元', 'CNY': '人民币', 'RMB': '人民币',
                    'EUR': '欧元', 'JPY': '日元', 'GBP': '英镑',
                    'CAD': '加元', 'AUD': '澳元',
                }.get(unit.upper(), unit)
                summary = f"中转账户余额 {window['remaining']:,.2f} {spoken_unit}".strip()
            else:
                entries = [
                    f"{window['name']}剩余{window['remaining']:g}%"
                    if window.get('remaining') is not None else f"{window['name']}暂无额度数据"
                    for window in windows if window.get('kind') != 'balance'
                ]
                summary = '额度查询完成。' + ('；'.join(entries) if entries else '暂无额度数据')
        except (KeyError, TypeError, ValueError, StopIteration):
            summary = '额度查询完成，详情请查看气泡。'
        self.announce(summary)

    def separator(self):
        line = QFrame(self)
        line.setFrameShape(QFrame.Shape.HLine)
        line.setFixedHeight(1)
        line.setStyleSheet('QFrame {color:'+card_colors(self)['separator']+';}')
        return line


def reduced_motion():
    """只读系统减少动态效果设置；查询失败时不强制播放装饰动画。"""
    if sys.platform != 'darwin':
        return True
    try:
        from desktop_visibility import _get_mac_desktop
        bridge = _get_mac_desktop()
        pool = bridge.pool()
        try:
            return bridge.msg_bool(bridge.workspace(), bridge.sel('accessibilityDisplayShouldReduceMotion'))
        finally:
            bridge.msg(pool, bridge.sel('drain'))
    except Exception:
        return True


class MenuSpacing(QProxyStyle):
    """统一每行的文字/勾选/图标/chevron 几何，避免系统字体符号基线不同。"""
    ROW_HEIGHT = 23
    INSET = 11

    @staticmethod
    def columns(widget):
        actions = widget.actions() if isinstance(widget, QMenu) else []
        return (16 if any(a.isCheckable() for a in actions) else 0,
                18 if any(not a.icon().isNull() for a in actions) else 0)

    def sizeFromContents(self, kind, option, size, widget=None):
        if kind == QStyle.ContentsType.CT_MenuItem:
            if option.menuItemType == QStyleOptionMenuItem.MenuItemType.Separator:
                return QSize(1, 9)
            checks, icons = self.columns(widget)
            # 统一预留右侧槽位，不让有子菜单的行改变文字对齐。
            text, _, shortcut = option.text.partition('\t')
            width = math.ceil(QFontMetricsF(option.font).horizontalAdvance(text.replace('&', '')))
            if shortcut:
                width += math.ceil(QFontMetricsF(option.font).horizontalAdvance(shortcut)) + 16
            return QSize(checks + icons + width + 23, self.ROW_HEIGHT)
        return super().sizeFromContents(kind, option, size, widget)

    def pixelMetric(self, metric, option=None, widget=None):
        if metric in (QStyle.PixelMetric.PM_MenuVMargin, QStyle.PixelMetric.PM_MenuHMargin):
            return self.INSET
        if metric == QStyle.PixelMetric.PM_MenuPanelWidth:
            return 0
        if metric == QStyle.PixelMetric.PM_SmallIconSize:
            return 14
        return super().pixelMetric(metric, option, widget)

    def drawControl(self, element, option, painter, widget=None):
        if element != QStyle.ControlElement.CE_MenuItem:
            return super().drawControl(element, option, painter, widget)
        colors = card_colors(widget)
        rect = QRectF(option.rect)
        painter.save()
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        if option.menuItemType == QStyleOptionMenuItem.MenuItemType.Separator:
            painter.setPen(QPen(QColor(colors['separator']), .65))
            painter.drawLine(QPointF(rect.left()+5, rect.center().y()),
                             QPointF(rect.right()-5, rect.center().y()))
            painter.restore()
            return
        enabled = bool(option.state & QStyle.StateFlag.State_Enabled)
        hovered = enabled and bool(option.state & QStyle.StateFlag.State_Selected)
        if hovered:
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(colors['accent']))
            painter.drawRoundedRect(rect.adjusted(0, 1, 0, -1), 5, 5)
        color = QColor('#ffffff' if hovered else colors['text'] if enabled else colors['muted'])
        painter.setPen(color)
        painter.setFont(option.font)
        checks, icons = self.columns(widget)
        left = rect.left() + 5
        cy = rect.center().y()
        if option.checked:
            x = left + 5
            path = QPainterPath(QPointF(x-3.5, cy))
            path.lineTo(x-1, cy+2.5)
            path.lineTo(x+3.8, cy-3)
            painter.setPen(QPen(color, 1.5, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
            painter.drawPath(path)
        if not option.icon.isNull():
            icon_rect = QRectF(left+checks, cy-7, 14, 14).toRect()
            option.icon.paint(painter, icon_rect)
        text_rect = QRectF(left+checks+icons, rect.top(), rect.width()-checks-icons-23, rect.height())
        text = option.text.split('\t')[0]
        painter.setPen(color)
        painter.drawText(text_rect, Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter |
                         Qt.TextFlag.TextShowMnemonic, text)
        if option.menuItemType == QStyleOptionMenuItem.MenuItemType.SubMenu:
            x = rect.right()-8
            path = QPainterPath(QPointF(x-1.6, cy-3))
            path.lineTo(x+1.4, cy)
            path.lineTo(x-1.6, cy+3)
            painter.setPen(QPen(color, 1.4, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
            painter.drawPath(path)
        shortcut = option.text.partition('\t')[2]
        if shortcut:
            painter.setPen(color)
            painter.drawText(text_rect, Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, shortcut)
        painter.restore()


class NativeMenu(QMenu):
    """Apple 卡片风格；仍由 QMenu 处理键盘、鼠标、勾选与子菜单。"""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowFlag(Qt.WindowType.FramelessWindowHint, True)
        self.setWindowFlag(Qt.WindowType.NoDropShadowWindowHint, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAutoFillBackground(False)
        self.setFont(system_font(11))
        self.spacing_style = MenuSpacing(QStyleFactory.create(QApplication.style().objectName()))
        self.spacing_style.setParent(self)
        self.setStyle(self.spacing_style)
        self.setSeparatorsCollapsible(True)
        self.setToolTipsVisible(True)
        self.setStyleSheet('')
        self.fade = QPropertyAnimation(self, b'windowOpacity', self)
        self.fade.setDuration(90)
        self.fade.setEasingCurve(QEasingCurve.Type.OutCubic)

    def paintEvent(self, event):
        painter = QPainter(self)
        colors = card_colors(self)
        card = paint_card(painter, self.rect(), colors)
        clip = QPainterPath()
        clip.addRoundedRect(card, 12, 12)
        painter.setClipPath(clip)
        for action in self.actions():
            if not action.isVisible():
                continue
            option = QStyleOptionMenuItem()
            self.initStyleOption(option, action)
            option.rect = self.actionGeometry(action)
            self.style().drawControl(QStyle.ControlElement.CE_MenuItem, option, painter, self)

    def showEvent(self, event):
        super().showEvent(event)
        self.fade.stop()
        if QApplication.platformName() == 'cocoa' and not reduced_motion():
            self.setWindowOpacity(0.0)
            self.fade.setStartValue(0.0)
            self.fade.setEndValue(1.0)
            self.fade.start()
        else:
            self.setWindowOpacity(1.0)

    def hideEvent(self, event):
        self.fade.stop()
        self.setWindowOpacity(1.0)
        super().hideEvent(event)

    def addMenu(self, title):
        submenu = NativeMenu(self)
        submenu.setTitle(title)
        super().addMenu(submenu)
        return submenu


def decorate_action(action, item, current):
    action.setData(item['id'])
    action.setToolTip(item['name'] if item.get('name') else item['id'])
    action.setCheckable(True)
    action.setChecked(bool(current and item['id'] == current.get('id')))
    return action
