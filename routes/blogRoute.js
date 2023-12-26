import Express from "express";
import { isAuthenticated } from "../middleware/auth.js";
import { createBlog, myBlogs, updateBlog, deleteBlog, getAllBlogs , getBlogById} from "../controllers/blogControllers.js";

const router = Express.Router();

router.post('/new', isAuthenticated, createBlog);
router.get('/myBlogs', isAuthenticated, myBlogs);
router.put('/:id', isAuthenticated, updateBlog);//updating existing blog
router.delete('/:id', isAuthenticated, deleteBlog);
router.get('/allBlogs', getAllBlogs);
router.get('/blog/:id',isAuthenticated, getBlogById); // working if authenticated 


export default router;