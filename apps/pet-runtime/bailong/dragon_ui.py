"""紧凑的卡片气泡和菜单；Qt 保留交互，统一绘制圆角、文字和图标。"""
import math
import sys
from datetime import datetime

from PySide6.QtCore import Qt, QSize, QRectF, QPointF, QPropertyAnimation, QEasingCurve
from PySide6.QtGui import (QFontDatabase, QFontMetricsF, QPainter, QColor,
                          QTextOption, QPainterPath, QPen, QPalette)
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


class FittedText(QTextBrowser):
    """先按最终宽度测量文字，再决定高度；只在超过阅读预算时滚动。"""
    def __init__(self, text='', parent=None, cap=168):
        super().__init__(parent)
        self.cap = self.preferred_cap = cap
        self._fitting = False
        self._measure_width = 240
        self.setFont(system_font())
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
            height = min(self.cap, max(math.ceil(QFontMetricsF(self.font()).height()) + 1, needed))
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
        self.layout.setSpacing(4)
        self.is_task_progress = self.is_quota_result = False
        self.kind = 'message'
        self.preferred_width = 260
        self.text_cap = 168
        self.fade = QPropertyAnimation(self, b'windowOpacity', self)
        self.fade.setDuration(90)
        self.fade.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.setFont(system_font())

    def configure_width(self, preferred):
        self.preferred_width = preferred
        area = (self.screen() or QApplication.primaryScreen()).availableGeometry()
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
        line_heights = [math.ceil(QFontMetricsF(v.font()).height()) + 1 for v in views]
        budget = max(sum(line_heights), min(264, area.height() - 24) - chrome)
        # 短标题实际用多少算多少，不按最大高度占位；优先把空间留给正文。
        remaining = budget
        for i, view in enumerate(views):
            reserve = sum(line_heights[i + 1:])
            view.cap = max(line_heights[i], min(view.preferred_cap, remaining - reserve))
            view.fit(width - outer)
            remaining -= view.height()
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

    def label(self, text, cap=None, title=False):
        label = FittedText(text, self, cap=cap or self.text_cap)
        if title:
            label.setFont(system_font(10, bold=True))
            label.document().setDefaultFont(label.font())
        palette = label.palette()
        palette.setColor(QPalette.ColorRole.Text, QColor(card_colors(self)['text']))
        label.setPalette(palette)
        self.layout.addWidget(label)
        return label

    def finish(self):
        area = (self.screen() or QApplication.primaryScreen()).availableGeometry()
        self._reflow(area)
        self.show()

    def message(self, text):
        self.kind = 'message'
        self.is_task_progress = self.is_quota_result = False
        self.configure_width(284)
        self.clear()
        self.result_view = self.label(text)
        self.finish()

    def task_result(self, title, text, details):
        self.kind = 'result'
        self.is_task_progress = False
        self.is_quota_result = True
        self.configure_width(316)
        self.clear()
        self.result_title = self.label(title, cap=42, title=True)
        self.result_view = self.label(text, cap=168)
        button = QPushButton('详情', self)
        button.setAccessibleName('详情')
        button.setFont(system_font(9))
        colors = card_colors(self)
        button.setStyleSheet('QPushButton {color:'+colors['accent']+';background:transparent;'
                             'border:0;border-radius:5px;padding:3px 6px;}'
                             'QPushButton:hover {background:rgba(0,122,255,20);}')
        button.clicked.connect(lambda checked=False: details())
        self.layout.addWidget(button, 0, Qt.AlignmentFlag.AlignRight)
        self.finish()

    def quota(self, windows, refreshed_at=None, refresh=None):
        self.kind = 'quota'
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
        title = QLabel('中转余额' if is_balance else 'Codex 额度', header)
        title.setFont(system_font(10, bold=True))
        title.setStyleSheet('color:'+colors['text']+';')
        header_layout.addWidget(title)
        header_layout.addStretch(1)
        if refresh is not None:
            button = QToolButton(header)
            button.setIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_BrowserReload))
            button.setAutoRaise(True)
            button.setFixedSize(24, 24)
            button.setToolTip('重新查询额度')
            button.setAccessibleName('重新查询额度')
            button.clicked.connect(lambda checked=False: refresh())
            header_layout.addWidget(button)
        self.layout.addWidget(header)
        if is_balance:
            window = next(w for w in windows if w.get('kind') == 'balance')
            amount = FittedText(f"{window['remaining']:,.2f}", self, cap=38)
            amount.setFont(system_font(23, bold=True))
            amount.document().setDefaultFont(amount.font())
            amount.setPalette(self.palette())
            self.layout.addWidget(amount)
            self.label(f"{window['name']} · {window['unit']}", cap=20)
            if len(windows) > 1:
                self.layout.addWidget(self.separator())
                self.label('其他窗口', cap=18, title=True)
        for window in windows:
            if window.get('kind') == 'balance' and is_balance:
                continue
            value = window['remaining']
            row = QWidget(self)
            row_layout = QHBoxLayout(row)
            row_layout.setContentsMargins(0, 0, 0, 0)
            row_layout.setSpacing(4)
            label = QLabel(window['name'], row)
            label.setFont(system_font(9))
            label.setStyleSheet('color:'+colors['text']+';')
            row_layout.addWidget(label)
            row_layout.addStretch(1)
            remaining = QLabel(f"{value:g}% 剩余" if value is not None else '暂未提供', row)
            remaining.setFont(system_font(9, bold=True))
            remaining.setStyleSheet('color:'+colors['text']+';')
            row_layout.addWidget(remaining)
            self.layout.addWidget(row)
            bar = QProgressBar(self)
            bar.setRange(0, 100)
            bar.setValue(round(value) if value is not None else 0)
            bar.setTextVisible(False)
            bar.setFixedHeight(6)
            fill = '#35a36f' if value is not None and value >= 60 else '#d69a36' if value is not None and value >= 25 else '#d65c58'
            bar.setStyleSheet('QProgressBar {border:0;border-radius:3px;background:'+colors['separator']+';}'
                              'QProgressBar::chunk {background:'+fill+';border-radius:3px;}')
            self.layout.addWidget(bar)
            if window.get('resetsAt'):
                self.label('重置于 ' + datetime.fromtimestamp(window['resetsAt']).strftime('%m月%d日 %H:%M'), cap=20)
        if refreshed_at:
            self.label('查询于 ' + refreshed_at.strftime('%H:%M'), cap=18)
        self.finish()

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
