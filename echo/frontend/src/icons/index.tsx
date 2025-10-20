const Document = (props: React.SVGProps<SVGSVGElement>) => (
	<svg
		width="12"
		height="14"
		viewBox="0 0 12 14"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		role="graphics-symbol img"
		{...props}
	>
		<path
			d="M11.06 5.2399H7.98C7.254 5.2399 6.66 4.6459 6.66 3.9199V0.839902C6.66 0.597902 6.462 0.399902 6.22 0.399902H1.82C1.094 0.399902 0.5 0.993902 0.5 1.7199V12.2799C0.5 13.0059 1.094 13.5999 1.82 13.5999H10.18C10.906 13.5999 11.5 13.0059 11.5 12.2799V5.6799C11.5 5.4379 11.302 5.2399 11.06 5.2399ZM11.412 3.3919L8.508 0.487902C8.442 0.421902 8.376 0.399902 8.288 0.399902C8.112 0.399902 7.98 0.531902 7.98 0.707902V3.0399C7.98 3.5239 8.376 3.9199 8.86 3.9199H11.192C11.368 3.9199 11.5 3.7879 11.5 3.6119C11.5 3.5239 11.478 3.4579 11.412 3.3919Z"
			fill="currentColor"
		/>
	</svg>
);

const Alert = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="16"
		height="16"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		role="graphics-symbol img"
	>
		<polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
		<line x1="12" y1="8" x2="12" y2="12" />
		<line x1="12" y1="16" x2="12.01" y2="16" />
	</svg>
);

const Plus: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
	<svg
		width="16"
		height="16"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		xmlns="http://www.w3.org/2000/svg"
		role="graphics-symbol img"
		{...props}
	>
		<path d="M9.25127 1.24994C9.25127 0.559616 8.69165 0 8.00133 0C7.31101 0 6.75139 0.559616 6.75139 1.24994V6.75042H1.24994C0.559616 6.75042 0 7.31003 0 8.00035C0 8.69068 0.559616 9.25029 1.24994 9.25029H6.75139V14.7501C6.75139 15.4404 7.31101 16 8.00133 16C8.69165 16 9.25127 15.4404 9.25127 14.7501V9.25029H14.7501C15.4404 9.25029 16 8.69068 16 8.00035C16 7.31003 15.4404 6.75042 14.7501 6.75042H9.25127V1.24994Z" />
	</svg>
);

import type { SVGProps } from "react";
import refresh from "../assets/refresh.png";

const Refresh = () => <img alt="" src={refresh} height={16} />;

const Octagon = ({
	color,
	...props
}: {
	color?: string;
} & React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			width="16"
			height="14"
			viewBox="0 0 16 14"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="graphics-symbol img"
			{...props}
		>
			<path
				d="M0 7L4 0.0717964H12L16 7L12 13.9282H4L0 7Z"
				fill={color || "currentColor"}
			/>
		</svg>
	);
};

const Diamond = ({
	color,
	...props
}: {
	color?: string;
} & React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="graphics-symbol img"
			{...props}
		>
			<path d="M0 8L8 0L16 8L8 16L0 8Z" fill={color || "currentColor"} />
		</svg>
	);
};

const Home = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={30}
		height={30}
		fill="none"
		role="graphics-symbol img"
		{...props}
	>
		<path
			fill="currentColor"
			d="M12.5 25v-7.5h5V25h6.25V15h3.75L15 3.75 2.5 15h3.75v10z"
		/>
	</svg>
);

const Calendar = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={12}
		height={13}
		fill="none"
		role="graphics-symbol img"
		{...props}
	>
		<path
			fill="currentColor"
			d="M10.628 1.3h-.619V0H8.771v1.3H3.82V0H2.58v1.3h-.62C1.279 1.3.73 1.882.73 2.6l-.006 9.1c0 .718.554 1.3 1.238 1.3h8.666c.684 0 1.239-.582 1.239-1.3V2.6c0-.718-.555-1.3-1.239-1.3m0 10.4H1.962V4.55h8.666z"
		/>
	</svg>
);

const Dots = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={12}
		height={4}
		fill="none"
		role="graphics-symbol img"
		{...props}
	>
		<path
			fill="currentColor"
			d="M1.5.5C.675.5 0 1.175 0 2s.675 1.5 1.5 1.5S3 2.825 3 2 2.325.5 1.5.5m9 0C9.675.5 9 1.175 9 2s.675 1.5 1.5 1.5S12 2.825 12 2 11.325.5 10.5.5M6 .5c-.825 0-1.5.675-1.5 1.5S5.175 3.5 6 3.5 7.5 2.825 7.5 2 6.825.5 6 .5"
		/>
	</svg>
);

const Pencil = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={20}
		height={20}
		fill="none"
		role="graphics-symbol img"
		{...props}
	>
		<path
			fill="currentColor"
			d="M18.214 17.232H1.786a.714.714 0 0 0-.715.714v.804c0 .098.08.178.179.178h17.5a.18.18 0 0 0 .179-.178v-.804a.714.714 0 0 0-.715-.714m-13.89-1.875q.066-.001.134-.011l3.754-.659a.22.22 0 0 0 .118-.062l9.462-9.462a.22.22 0 0 0 0-.315l-3.71-3.712a.22.22 0 0 0-.158-.065.22.22 0 0 0-.158.065l-9.462 9.462a.23.23 0 0 0-.063.118l-.658 3.755a.75.75 0 0 0 .21.665.76.76 0 0 0 .53.221"
		/>
	</svg>
);

const Gear = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={24}
		height={24}
		fill="none"
		role="graphics-symbol img"
		{...props}
	>
		<path
			fill="currentColor"
			d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61zM12 15.6A3.61 3.61 0 0 1 8.4 12c0-1.98 1.62-3.6 3.6-3.6s3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6"
		/>
	</svg>
);

const Stars = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={21}
		height={21}
		fill="none"
		role="graphics-symbol img"
		{...props}
	>
		<path
			fill="currentColor"
			d="M12.292 4.264a.44.44 0 0 0-.3-.414l-1.09-.366a2.3 2.3 0 0 1-1.454-1.422L9.083.974a.439.439 0 0 0-.813 0l-.382 1.088a2.3 2.3 0 0 1-1.454 1.455l-1.089.365a.439.439 0 0 0 0 .813l1.089.366a2.3 2.3 0 0 1 1.454 1.454l.366 1.089a.439.439 0 0 0 .813 0l.365-1.089a2.3 2.3 0 0 1 1.454-1.454l1.09-.366a.44.44 0 0 0 .316-.43m7.646 5.631-1.227-.406a2.58 2.58 0 0 1-1.625-1.625l-.406-1.227a.488.488 0 0 0-.935 0l-.406 1.227a2.58 2.58 0 0 1-1.625 1.625l-1.227.406a.487.487 0 0 0 0 .934l1.227.407a2.58 2.58 0 0 1 1.625 1.625l.406 1.226a.488.488 0 0 0 .935 0l.406-1.226a2.58 2.58 0 0 1 1.625-1.625l1.227-.407a.487.487 0 0 0 0-.934m-9.563 4.964-1.625-.528a3.35 3.35 0 0 1-2.121-2.12l-.528-1.625a.641.641 0 0 0-1.21 0l-.529 1.625a3.35 3.35 0 0 1-2.088 2.12l-1.625.528a.642.642 0 0 0 0 1.211l1.625.528a3.35 3.35 0 0 1 2.12 2.129l.529 1.625a.642.642 0 0 0 1.21 0l.529-1.625a3.35 3.35 0 0 1 2.12-2.12l1.625-.529a.642.642 0 0 0 0-1.21z"
		/>
	</svg>
);

const DocumentOutline = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={12}
		height={14}
		fill="none"
		role="graphics-symbol img"
		{...props}
	>
		<path
			stroke="currentColor"
			strokeWidth={1.25}
			d="M7.98 5.865h2.895v6.415c0 .38-.314.695-.695.695H1.82a.7.7 0 0 1-.695-.695V1.72c0-.38.314-.695.695-.695h4.215V3.92c0 1.071.874 1.945 1.945 1.945Zm.625-4.396 1.826 1.826H8.86a.26.26 0 0 1-.255-.255z"
		/>
	</svg>
);

const DocumentFilled = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={12}
		height={14}
		fill="none"
		role="graphics-symbol img"
		{...props}
	>
		<path
			fill="currentColor"
			d="M11.06 5.24H7.98c-.726 0-1.32-.594-1.32-1.32V.84A.44.44 0 0 0 6.22.4h-4.4C1.094.4.5.994.5 1.72v10.56c0 .726.594 1.32 1.32 1.32h8.36c.726 0 1.32-.594 1.32-1.32v-6.6a.44.44 0 0 0-.44-.44m.352-1.848L8.508.488A.28.28 0 0 0 8.288.4a.3.3 0 0 0-.308.308V3.04c0 .484.396.88.88.88h2.332a.3.3 0 0 0 .308-.308.28.28 0 0 0-.088-.22"
		/>
	</svg>
);

const Phone = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={10}
		height={18}
		fill="none"
		role="graphics-symbol img"
		{...props}
	>
		<path
			fill="#000"
			d="M1.111 2.455v12.272H8.89V2.455zM1.666 0h6.668C9.458 0 10 .803 10 2.045v13.91C10 17.197 9.458 18 8.334 18H1.666C.542 18 0 17.197 0 15.954V2.045C0 .803.542 0 1.666 0"
		/>
	</svg>
);

const Signal = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={20}
		height={16}
		fill="none"
		role="graphics-symbol img"
		{...props}
	>
		<path d="M10 5.9a2 2 0 1 1 0 4 2 2 0 0 1 0-4m0 1.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1m3.17-2.69a.75.75 0 0 1 1.19-.912A6.72 6.72 0 0 1 15.75 7.9a6.73 6.73 0 0 1-1.5 4.245.753.753 0 0 1-1.243-.114.75.75 0 0 1 .076-.83 5.23 5.23 0 0 0 1.167-3.3 5.22 5.22 0 0 0-1.08-3.191m-6.338-.003a.75.75 0 0 0-1.19-.913A6.72 6.72 0 0 0 4.25 7.9c0 1.606.562 3.083 1.499 4.242a.748.748 0 0 0 1.255-.104.75.75 0 0 0-.089-.84A5.23 5.23 0 0 1 5.75 7.9c0-1.202.403-2.308 1.082-3.193" />
		<path d="M16.034 1.893a.75.75 0 0 1 1.14-.975A10.7 10.7 0 0 1 19.75 7.9c0 2.726-1.015 5.217-2.688 7.11a.75.75 0 1 1-1.124-.991 9.2 9.2 0 0 0 2.312-6.12 9.2 9.2 0 0 0-2.216-6.006m-12.068 0a.75.75 0 1 0-1.14-.975A10.7 10.7 0 0 0 .25 7.9c0 2.723 1.013 5.21 2.68 7.104a.75.75 0 1 0 1.126-.992A9.2 9.2 0 0 1 1.75 7.9a9.2 9.2 0 0 1 2.216-6.007" />
	</svg>
);

const LightBulb = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={22}
		height={22}
		fill="none"
		role="graphics-symbol img"
		{...props}
	>
		<g fill="#000" clipPath="url(#a)">
			<path d="M18.26 21.08H3.774A2.85 2.85 0 0 1 .917 18.23V3.765A2.85 2.85 0 0 1 3.774.915H18.26c1.547 0 2.824 1.274 2.824 2.85v14.463c0 1.579-1.277 2.853-2.824 2.853M3.774 2.928a.83.83 0 0 0-.84.839v14.462c0 .47.37.84.84.84H18.26a.83.83 0 0 0 .84-.839V3.765c-.033-.47-.402-.839-.84-.839z" />
			<path d="M11 6a3.497 3.497 0 0 0-2 6.37v1.13c0 .275.225.5.5.5h3c.275 0 .5-.225.5-.5v-1.13A3.498 3.498 0 0 0 11 6m-1.5 9.5c0 .275.225.5.5.5h2c.275 0 .5-.225.5-.5V15h-3z" />
		</g>
		<defs>
			<clipPath id="a">
				<path fill="#fff" d="M0 0h22v22H0z" />
			</clipPath>
		</defs>
	</svg>
);

const View = (props: SVGProps<SVGSVGElement>) => (
	<svg
		width="19"
		height="13"
		viewBox="0 0 19 13"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		role="graphics-symbol img"
		{...props}
	>
		<path
			fill-rule="evenodd"
			clip-rule="evenodd"
			d="M0 1C0 0.447715 0.447715 0 1 0H18C18.5523 0 19 0.447715 19 1V12C19 12.5523 18.5523 13 18 13H1C0.447715 13 0 12.5523 0 12V1ZM10 2V7H2V11H17V2H10Z"
			fill="#909296"
		/>
	</svg>
);

const Sidebar = (props: SVGProps<SVGSVGElement>) => (
	<svg
		width="20"
		height="20"
		viewBox="0 0 20 20"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		role="graphics-symbol img"
		{...props}
	>
		<g clip-path="url(#clip0_449_2732)">
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M3.43148 19.1634H16.6006C18.0065 19.1634 19.1673 18.0051 19.1673 16.5701V3.42258C19.1673 1.98925 18.0065 0.830083 16.6006 0.830083H3.43148C3.09068 0.829426 2.75309 0.89597 2.43803 1.02591C2.12297 1.15585 1.83663 1.34663 1.59537 1.58734C1.35412 1.82806 1.16269 2.11398 1.03204 2.42874C0.901396 2.74351 0.834093 3.08095 0.833984 3.42175V16.5709C0.833984 16.9118 0.901206 17.2493 1.0318 17.5642C1.1624 17.879 1.35381 18.1651 1.59508 18.4059C1.83634 18.6467 2.12273 18.8375 2.43784 18.9675C2.75296 19.0975 3.09061 19.1641 3.43148 19.1634ZM3.13813 2.71583C3.23123 2.67792 3.33096 2.65897 3.43148 2.66008L7.05717 2.65985V17.3334H3.43148C3.00315 17.3334 2.66732 16.9976 2.66732 16.5701V3.42258C2.66642 3.32206 2.68559 3.22237 2.7237 3.12935C2.76181 3.03632 2.81809 2.95184 2.88925 2.88083C2.96041 2.80983 3.04502 2.75373 3.13813 2.71583ZM9.30717 17.3334H16.6006C16.7012 17.3345 16.8009 17.3156 16.894 17.2777C16.9871 17.2398 17.0717 17.1837 17.1429 17.1127C17.214 17.0417 17.2703 16.9572 17.3084 16.8642C17.3465 16.7711 17.3657 16.6714 17.3648 16.5709V3.42175C17.334 2.99508 16.9981 2.65925 16.6006 2.65925L9.30717 2.65971V17.3334Z"
				fill="black"
				stroke="black"
				strokeWidth="0.5"
			/>
		</g>
		<defs>
			<clipPath id="clip0_449_2732">
				<rect width="20" height="20" fill="white" />
			</clipPath>
		</defs>
	</svg>
);

const Aspect = (props: SVGProps<SVGSVGElement>) => (
	<svg
		width="21"
		height="14"
		viewBox="0 0 21 14"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		role="graphics-symbol img"
		{...props}
	>
		<path
			d="M2.25391 2.23633H19.3356M2.25391 5.69334H9.16794M2.25391 9.15036H5.91427M2.25391 12.6074H4.69415M7.1344 12.6074H9.57464M12.0149 12.6074H14.4551M16.8954 12.6074H19.3356M8.96458 9.15036H12.625M15.6753 9.15036H19.3356M12.4216 5.69334H19.3356"
			stroke="#909296"
			stroke-width="1.25"
			stroke-linecap="round"
		/>
	</svg>
);

export const Icons = {
	Alert,
	Aspect,
	Calendar,
	Diamond,
	Document,
	DocumentFilled,
	DocumentOutline,
	Dots,
	Gear,
	Home,
	LightBulb,
	Octagon,
	Pencil,
	Phone,
	Plus,
	Refresh,
	Sidebar,
	Signal,
	Stars,
	View,
};
